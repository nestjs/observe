import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { propagation } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  createServer,
  IncomingHttpHeaders,
  request as httpRequest,
  Server,
} from "http";
import request from "supertest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  listenOnLoopback,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";
import {
  readTraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";

/** See outgoing-scenarios.int-spec.ts: the one channel that can set headers. */
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeHttpCanPropagate =
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);

// The W3C spec's own example.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${CALLER_SPAN_ID}-01`;

let downstreamUrl = "";

function nodeHttp(url: string, headers?: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

@Injectable()
class CallerService {
  async viaFetch(path: string, headers?: Record<string, string>) {
    const response = await fetch(`${downstreamUrl}${path}`, { headers });
    await response.text();
    return response.status;
  }

  viaNodeHttp(path: string, headers?: Record<string, string>) {
    return nodeHttp(`${downstreamUrl}${path}`, headers);
  }
}

@Controller()
class CallerController {
  constructor(private readonly caller: CallerService) {}

  @Get("fetch")
  fetch(@Query("path") path: string, @Query("own") own?: string) {
    return this.caller.viaFetch(
      path,
      own ? { traceparent: own, tracestate: "caller=own" } : undefined,
    );
  }

  @Get("node")
  node(@Query("path") path: string, @Query("own") own?: string) {
    return this.caller.viaNodeHttp(
      path,
      own ? { traceparent: own } : undefined,
    );
  }
}

async function bootApp(overrides: Partial<ObserveOptions> = {}) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers: [CallerController],
    providers: [CallerService],
  })
  class CallerModule {}

  const app = await NestFactory.create(CallerModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  const collected = collectSnapshots(app);
  const url = await listenOnLoopback(app);
  return { app, collected, url };
}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

/**
 * W3C Trace Context on both sides of a service: the `traceparent` a request
 * arrives with decides which trace it joins, and every outbound call carries
 * one naming that trace and the call's own span - so a service instrumented
 * with OpenTelemetry, in any language, continues the trace this agent is in,
 * and the other way round.
 */
describe("ObserveModule: W3C trace context", () => {
  let downstream: Server;
  const received: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    downstream = createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      res.end("ok");
    });
    downstreamUrl = await listenOnLoopback(downstream);
  });

  afterAll(async () => {
    downstream.closeAllConnections();
    await new Promise((resolve) => downstream.close(resolve));
  });

  const callTo = (path: string) => {
    const call = received.find((item) => item.url === path);
    if (!call) {
      throw new Error(`No call to ${path} reached the downstream service.`);
    }
    return call;
  };

  describe("with the defaults", () => {
    let app: INestApplication;
    let url = "";
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      ({ app, collected, url } = await bootApp());
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      received.length = 0;
    });

    // The downstream path rides in the query string, slash encoded.
    const snapshotFor = (path: string) =>
      waitForSnapshot(collected, (item) =>
        decodeURIComponent(item.attributes?.originalUrl ?? "").includes(
          `path=${path}`,
        ),
      );

    it("joins the trace a traceparent names, and carries it on under the call's own span", async () => {
      await request(url)
        .get("/fetch")
        .query({ path: "/joined" })
        .set("traceparent", TRACEPARENT)
        .set("tracestate", "vendor=abc")
        .expect(200);

      const snapshot = await snapshotFor("/joined");
      const [span] = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "http",
      );
      const call = callTo("/joined");

      expect(snapshot.traceId).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
      expect(call.headers["x-request-id"]).toBe(snapshot.traceId);
      expect(readTraceContext(call.headers)).toEqual({
        traceId: TRACE_ID,
        // The outbound span, not the caller's: the callee nests under it.
        parentSpanId: w3cSpanIdOf(span.spanId!),
        sampled: true,
        traceState: "vendor=abc",
      });
    });

    it("lets the traceparent name the trace over a proxy's x-request-id, and sends that id on", async () => {
      // A mesh setting x-request-id in front of a caller already in an
      // OpenTelemetry trace: the request is reported under the id the trace
      // has in the caller's backend, and both headers name it from here on.
      await request(url)
        .get("/fetch")
        .query({ path: "/both" })
        .set("x-request-id", "proxy-request-1")
        .set("traceparent", TRACEPARENT)
        .expect(200);

      const snapshot = await snapshotFor("/both");
      const call = callTo("/both");

      expect(snapshot.traceId).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
      expect(call.headers["x-request-id"]).toBe(snapshot.traceId);
      expect(readTraceContext(call.headers)?.traceId).toBe(TRACE_ID);
    });

    it("keeps an x-request-id that names the traceparent's own trace", async () => {
      // What another service running the agent sends for a custom id: the
      // id itself, and a traceparent carrying the trace id derived from it.
      await request(url)
        .get("/fetch")
        .query({ path: "/same-trace" })
        .set("x-request-id", "req_8f2c")
        .set(
          "traceparent",
          `00-${w3cTraceIdOf("req_8f2c")}-${CALLER_SPAN_ID}-01`,
        )
        .expect(200);

      const snapshot = await snapshotFor("/same-trace");
      const call = callTo("/same-trace");

      expect(snapshot.traceId).toBe("req_8f2c");
      expect(call.headers["x-request-id"]).toBe("req_8f2c");
      expect(readTraceContext(call.headers)?.traceId).toBe(
        w3cTraceIdOf("req_8f2c"),
      );
    });

    it("starts a W3C trace of its own from the trace id it minted", async () => {
      await request(url).get("/fetch").query({ path: "/minted" }).expect(200);

      const snapshot = await snapshotFor("/minted");
      const context = readTraceContext(callTo("/minted").headers);

      expect(context?.traceId).toBe(snapshot.traceId.replace(/-/g, ""));
      expect(context?.sampled).toBe(true);
      expect(context?.traceState).toBeUndefined();
    });

    it("derives one W3C trace from an x-request-id that is not hex", async () => {
      await request(url)
        .get("/fetch")
        .query({ path: "/custom-id" })
        .set("x-request-id", "req_8f2c")
        .expect(200);

      expect(readTraceContext(callTo("/custom-id").headers)?.traceId).toBe(
        w3cTraceIdOf("req_8f2c"),
      );
    });

    it("never replaces a traceparent the application set itself, nor adds a tracestate beside it", async () => {
      const own = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
      await request(url)
        .get("/fetch")
        .query({ path: "/own", own })
        .set("tracestate", "vendor=abc")
        .set("traceparent", TRACEPARENT)
        .expect(200);

      const call = callTo("/own");
      expect(call.headers.traceparent).toBe(own);
      expect(call.headers.tracestate).toBe("caller=own");
      // x-request-id is a different header, and still goes.
      expect(call.headers["x-request-id"]).toBeDefined();
    });

    it.runIf(nodeHttpCanPropagate)(
      "names the node:http span in the traceparent, though that span opens after the headers are sent",
      async () => {
        await request(url)
          .get("/node")
          .query({ path: "/node-joined" })
          .set("traceparent", TRACEPARENT)
          .expect(200);

        const snapshot = await snapshotFor("/node-joined");
        const [span] = spansOf(
          snapshot.traces as CompleteTraceEventNode[],
          "http",
        );
        const context = readTraceContext(callTo("/node-joined").headers);

        expect(span).toBeDefined();
        expect(context?.traceId).toBe(TRACE_ID);
        expect(context?.parentSpanId).toBe(w3cSpanIdOf(span.spanId!));
      },
    );

    it.runIf(nodeHttpCanPropagate)(
      "leaves a node:http request's own traceparent alone",
      async () => {
        const own = `00-${"c".repeat(32)}-${"d".repeat(16)}-00`;
        await request(url)
          .get("/node")
          .query({ path: "/node-own", own })
          .expect(200);

        expect(callTo("/node-own").headers.traceparent).toBe(own);
      },
    );

    it("passes on an unsampled caller's decision", async () => {
      await request(url)
        .get("/fetch")
        .query({ path: "/unsampled" })
        .set("traceparent", `00-${TRACE_ID}-${CALLER_SPAN_ID}-00`)
        .expect(200);

      expect(readTraceContext(callTo("/unsampled").headers)?.sampled).toBe(
        false,
      );
    });
  });

  describe("for a request the sampler left out", () => {
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      ({ app, url } = await bootApp({ tracesSampleRate: () => false }));
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      received.length = 0;
    });

    it("still carries the trace on, marked unsampled when it started here", async () => {
      await request(url)
        .get("/fetch")
        .query({ path: "/sampled-out" })
        .expect(200);

      const context = readTraceContext(callTo("/sampled-out").headers);
      expect(context).toBeDefined();
      expect(context?.sampled).toBe(false);
    });

    it("and with the caller's own decision when it came with one", async () => {
      await request(url)
        .get("/fetch")
        .query({ path: "/sampled-out-joined" })
        .set("traceparent", TRACEPARENT)
        .expect(200);

      expect(readTraceContext(callTo("/sampled-out-joined").headers)).toEqual(
        expect.objectContaining({ traceId: TRACE_ID, sampled: true }),
      );
    });
  });

  describe("with outgoing.http.traceContext: false", () => {
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      ({ app, url } = await bootApp({
        outgoing: { http: { traceContext: false } },
      }));
    });

    afterAll(async () => {
      await app?.close();
    });

    it("sends x-request-id alone", async () => {
      received.length = 0;
      const routes = nodeHttpCanPropagate ? ["/fetch", "/node"] : ["/fetch"];
      for (const route of routes) {
        await request(url)
          .get(route)
          .query({ path: `/w3c-off${route}` })
          .set("traceparent", TRACEPARENT)
          .expect(200);
      }

      for (const call of received) {
        expect(call.headers["x-request-id"]).toBeDefined();
        expect(call.headers).not.toHaveProperty("traceparent");
        expect(call.headers).not.toHaveProperty("tracestate");
      }
    });
  });

  describe("beside an OpenTelemetry SDK that propagates W3C trace context", () => {
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      // What registering an SDK does to the global API. Its instrumentations
      // write traceparent on the calls they cover, so the agent writing one
      // too would put two on a request - see the coexistence suite for the
      // SDK itself.
      propagation.setGlobalPropagator(new W3CTraceContextPropagator());
      ({ app, url } = await bootApp());
    });

    afterAll(async () => {
      await app?.close();
      propagation.disable();
    });

    it("leaves traceparent to it, and still sends x-request-id", async () => {
      received.length = 0;
      const routes = nodeHttpCanPropagate ? ["/fetch", "/node"] : ["/fetch"];
      for (const route of routes) {
        await request(url)
          .get(route)
          .query({ path: `/beside-sdk${route}` })
          .expect(200);
      }

      expect(received).toHaveLength(routes.length);
      for (const call of received) {
        expect(call.headers["x-request-id"]).toBeDefined();
        expect(call.headers).not.toHaveProperty("traceparent");
      }
    });
  });

  describe("with outgoing.http.propagateTraceId narrowed", () => {
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      ({ app, url } = await bootApp({
        outgoing: {
          http: { propagateTraceId: (url) => !url.includes("/third-party") },
        },
      }));
    });

    afterAll(async () => {
      await app?.close();
    });

    it("sends no trace context of either kind where it says not to", async () => {
      received.length = 0;
      await request(url)
        .get("/fetch")
        .query({ path: "/third-party" })
        .set("traceparent", TRACEPARENT)
        .expect(200);

      const call = callTo("/third-party");
      expect(call.headers).not.toHaveProperty("x-request-id");
      expect(call.headers).not.toHaveProperty("traceparent");
    });
  });
});

/**
 * Two services running the agent, with a hop between them that speaks only
 * W3C Trace Context - what a service instrumented with OpenTelemetry passes
 * on: `traceparent` survives it, `x-request-id` does not. The trace still
 * arrives as one, because the id `traceparent` carries is the trace id
 * itself.
 */
describe("ObserveModule: a trace through a hop that only passes traceparent on", () => {
  const front = createObserveModule();
  const back = createObserveModule();
  let backUrl = "";
  let hopUrl = "";
  let frontUrl = "";
  let frontApp: INestApplication;
  let backApp: INestApplication;
  let hop: Server;
  let frontSnapshots: CollectedSnapshots;
  let backSnapshots: CollectedSnapshots;

  @Controller()
  class FrontController {
    @Get("checkout")
    async checkout() {
      const response = await fetch(`${hopUrl}/stock`);
      return { stock: await response.text() };
    }
  }

  @Controller()
  class BackController {
    @Get("stock")
    stock() {
      return "3";
    }
  }

  @Module({
    imports: [
      front.ObserveModule.forRoot(testObserveOptions({ serviceId: "front" })),
    ],
    controllers: [FrontController],
  })
  class FrontModule {}

  @Module({
    imports: [
      back.ObserveModule.forRoot(testObserveOptions({ serviceId: "back" })),
    ],
    controllers: [BackController],
  })
  class BackModule {}

  beforeAll(async () => {
    backApp = await NestFactory.create(BackModule, {
      instrument: back.ObserveInstrument,
      logger: false,
    });
    backSnapshots = collectSnapshots(backApp);
    backUrl = await listenOnLoopback(backApp);

    hop = createServer((req, res) => {
      const forwarded: Record<string, string> = {};
      if (typeof req.headers.traceparent === "string") {
        forwarded.traceparent = req.headers.traceparent;
      }
      const upstream = httpRequest(
        `${backUrl}${req.url}`,
        { headers: forwarded },
        (reply) => {
          res.statusCode = reply.statusCode ?? 502;
          reply.pipe(res);
        },
      );
      upstream.once("error", () => res.writeHead(502).end());
      upstream.end();
    });
    hopUrl = await listenOnLoopback(hop);

    frontApp = await NestFactory.create(FrontModule, {
      instrument: front.ObserveInstrument,
      logger: false,
    });
    frontSnapshots = collectSnapshots(frontApp);
    frontUrl = await listenOnLoopback(frontApp);
  });

  afterAll(async () => {
    await frontApp?.close();
    await backApp?.close();
    hop?.closeAllConnections();
    await new Promise((resolve) => hop?.close(resolve));
  });

  it("opens the far service's request under the near one's trace id", async () => {
    await request(frontUrl).get("/checkout").expect(200);

    const near = await waitForSnapshot(
      frontSnapshots,
      (item) => item.operationId === "/checkout",
    );
    const far = await waitForSnapshot(
      backSnapshots,
      (item) => item.operationId === "/stock",
    );

    expect(far.traceId).toBe(near.traceId);
  });
});
