// First, before anything that loads http, express, fastify, @nestjs/core or
// pg: the SDK's instrumentations patch only what loads after it starts.
import {
  openTelemetrySpans,
  shutdownOpenTelemetry,
} from "../testing/opentelemetry-sdk.js";
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { context, SpanKind } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { createServer, IncomingHttpHeaders, Server } from "http";
import { createRequire } from "module";
import { connect } from "net";
import pg from "pg";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { RequestSnapshot } from "../interfaces/index.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  listenOnLoopback,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";
import { readTraceContext } from "../utils/trace-context.util.js";

/**
 * `http` as compiled CommonJS reads it: `http.request` looked up at each call,
 * which is the function the SDK's patch put there. An ESM named import of a
 * builtin is bound once, before or after the patch alike.
 */
const http = createRequire(import.meta.url)("http") as typeof import("http");

const PG = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54321),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres-whisprr",
  database: process.env.PGDATABASE ?? "postgres",
};

/** The query assertions need a real server; the HTTP ones do not. */
const postgresReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: PG.host, port: PG.port });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

// The W3C spec's own example.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const CALLER_SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${CALLER_SPAN_ID}-01`;

let downstreamUrl = "";
let pool: pg.Pool | undefined;

function nodeHttp(url: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(url, { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

@Injectable()
class OrdersService {
  list() {
    return ["order-1"];
  }

  async viaFetch(path: string) {
    const response = await fetch(`${downstreamUrl}${path}`);
    await response.text();
    return response.status;
  }

  viaNodeHttp(path: string) {
    return nodeHttp(`${downstreamUrl}${path}`);
  }

  async query() {
    const { rows } = await pool!.query<{ one: number }>("SELECT 1 AS one");
    return rows[0].one;
  }
}

@Controller()
class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get("orders/:label")
  list() {
    return this.orders.list();
  }

  @Get("fetch/:label")
  fetch(@Param("label") label: string) {
    return this.orders.viaFetch(`/${label}`);
  }

  @Get("node/:label")
  node(@Param("label") label: string) {
    return this.orders.viaNodeHttp(`/${label}`);
  }

  @Get("query/:label")
  query() {
    return this.orders.query();
  }
}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

const asUuid = (hex: string) =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

afterAll(async () => {
  await shutdownOpenTelemetry();
});

/**
 * Each HTTP adapter Nest ships, `undefined` being Express, the default - and
 * once more with `openTelemetry` left off, where the agent must not notice
 * the SDK at all.
 */
const suites: Array<[string, () => FastifyAdapter | undefined, boolean]> = [
  ["Express", () => undefined, true],
  ["Fastify", () => new FastifyAdapter(), true],
  ["Express, with openTelemetry off", () => undefined, false],
];

/**
 * The agent beside the OpenTelemetry Node SDK and its auto-instrumentations,
 * in one Nest process - how a team already on OpenTelemetry adds Observe to
 * its Nest service. Both have to keep working, and they have to agree on the
 * trace: one trace id for a request in both tools, and one `traceparent` on
 * every call out, the SDK's.
 */
describe.each(suites)(
  "ObserveModule beside the OpenTelemetry Node SDK, on %s",
  (_, adapter, openTelemetry) => {
    let app: INestApplication;
    let url = "";
    let collected: CollectedSnapshots;
    let downstream: Server;
    const received: Array<{
      url?: string;
      headers: IncomingHttpHeaders;
      rawHeaders: string[];
    }> = [];

    beforeAll(async () => {
      downstream = createServer((req, res) => {
        received.push({
          url: req.url,
          headers: req.headers,
          rawHeaders: req.rawHeaders,
        });
        res.end("ok");
      });
      downstreamUrl = await listenOnLoopback(downstream);

      const { ObserveModule, ObserveInstrument } = createObserveModule();

      @Module({
        imports: [ObserveModule.forRoot(testObserveOptions({ openTelemetry }))],
        controllers: [OrdersController],
        providers: [OrdersService],
      })
      class OrdersModule {}

      const httpAdapter = adapter();
      const options = { instrument: ObserveInstrument, logger: false } as const;
      app = httpAdapter
        ? await NestFactory.create(OrdersModule, httpAdapter, options)
        : await NestFactory.create(OrdersModule, options);
      collected = collectSnapshots(app);
      url = await listenOnLoopback(app);
      if (postgresReachable) {
        // After the app: the agent patches the driver as it starts.
        pool = new pg.Pool({ ...PG, max: 1 });
      }
    });

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
      await app?.close();
      downstream?.closeAllConnections();
      await new Promise((resolve) => downstream?.close(resolve));
    });

    // Both suites ask for the same paths.
    beforeEach(() => {
      openTelemetrySpans.reset();
    });

    /**
     * A caller outside any trace. The SDK instruments this process's own
     * client too, and would otherwise start a trace for each call the suite
     * makes and send its `traceparent` along.
     */
    const call = (path: string, headers: Record<string, string> = {}) =>
      context.with(suppressTracing(context.active()), () =>
        nodeHttp(`${url}${path}`, headers),
      );

    const snapshotFor = (path: string): Promise<RequestSnapshot> =>
      waitForSnapshot(
        collected,
        (item) => item.attributes?.originalUrl === path,
      );

    const pathOf = (span: ReadableSpan) =>
      String(
        span.attributes["url.path"] ?? span.attributes["http.target"] ?? "",
      );

    /** The SDK's server span for a request to `path`. */
    const serverSpanFor = async (path: string): Promise<ReadableSpan> => {
      const find = () =>
        openTelemetrySpans
          .getFinishedSpans()
          .find(
            (span) => span.kind === SpanKind.SERVER && pathOf(span) === path,
          );
      await waitFor(
        () => find() !== undefined,
        3000,
        `a server span for ${path}`,
      );
      return find()!;
    };

    const spansInTrace = (traceId: string) =>
      openTelemetrySpans
        .getFinishedSpans()
        .filter((span) => span.spanContext().traceId === traceId);

    const callTo = (path: string) => {
      const found = received.find((item) => item.url === path);
      if (!found) {
        throw new Error(`No call to ${path} reached the downstream service.`);
      }
      return found;
    };

    /** Every `traceparent` the call carried - Node folds repeats into one value. */
    const traceparentsOf = (rawHeaders: string[]) =>
      rawHeaders.filter(
        (value, index) =>
          index % 2 === 0 && value.toLowerCase() === "traceparent",
      ).length;

    if (!openTelemetry) {
      it("names requests by a UUIDv7 of its own, as before, whatever trace the SDK is in", async () => {
        expect(await call("/orders/off-root")).toBe(200);
        expect(
          await call("/orders/off-joined", { traceparent: TRACEPARENT }),
        ).toBe(200);

        const root = await snapshotFor("/orders/off-root");
        const joined = await snapshotFor("/orders/off-joined");
        const server = await serverSpanFor("/orders/off-root");

        expect(root.traceId[14]).toBe("7");
        expect(root.traceId).not.toBe(asUuid(server.spanContext().traceId));
        expect(joined.traceId[14]).toBe("7");
        expect(joined.traceId).not.toBe(asUuid(TRACE_ID));
      });

      it("sends its own x-request-id on calls out, and only the SDK's traceparent", async () => {
        expect(await call("/fetch/off-out")).toBe(200);

        const snapshot = await snapshotFor("/fetch/off-out");
        const server = await serverSpanFor("/fetch/off-out");
        const outbound = callTo("/off-out");
        const traceContext = readTraceContext(outbound.headers);

        expect(outbound.headers["x-request-id"]).toBe(snapshot.traceId);
        expect(traceparentsOf(outbound.rawHeaders)).toBe(1);
        // The SDK's own, as it would be without the agent there at all.
        expect(traceContext?.traceId).toBe(server.spanContext().traceId);
        expect(
          spansInTrace(server.spanContext().traceId).some(
            (span) =>
              span.kind === SpanKind.CLIENT &&
              span.spanContext().spanId === traceContext?.parentSpanId,
          ),
        ).toBe(true);
      });
      return;
    }

    it("reports a request that starts a trace under the trace id the SDK gave it", async () => {
      expect(await call("/orders/root")).toBe(200);

      const snapshot = await snapshotFor("/orders/root");
      const server = await serverSpanFor("/orders/root");

      expect(snapshot.traceId).toBe(asUuid(server.spanContext().traceId));
      // Both kept recording what each records: the agent its provider spans,
      // the SDK its own around Nest's handler.
      expect(
        spansOf(snapshot.traces as CompleteTraceEventNode[], "OrdersService"),
      ).toHaveLength(1);
      expect(
        spansInTrace(server.spanContext().traceId).some(
          (span) => span.attributes["nestjs.type"] !== undefined,
        ),
      ).toBe(true);
    });

    it("continues the caller's trace in both", async () => {
      expect(await call("/orders/joined", { traceparent: TRACEPARENT })).toBe(
        200,
      );

      const snapshot = await snapshotFor("/orders/joined");
      const server = await serverSpanFor("/orders/joined");

      expect(snapshot.traceId).toBe(asUuid(TRACE_ID));
      expect(server.spanContext().traceId).toBe(TRACE_ID);
      expect(server.parentSpanContext?.spanId).toBe(CALLER_SPAN_ID);
    });

    it("keeps to the SDK's trace over a mesh's x-request-id", async () => {
      expect(
        await call("/orders/meshed", {
          "x-request-id": "6f1a52c4-3d0b-4e8a-9c2f-7b1d0e9a8c34",
          traceparent: TRACEPARENT,
        }),
      ).toBe(200);

      expect((await snapshotFor("/orders/meshed")).traceId).toBe(
        asUuid(TRACE_ID),
      );
    });

    for (const client of ["fetch", "node"] as const) {
      it(`sends one traceparent on a ${client === "fetch" ? "fetch" : "node:http"} call, the SDK's, beside the agent's x-request-id`, async () => {
        const path = `/${client}/out-${client}`;
        expect(await call(path)).toBe(200);

        const snapshot = await snapshotFor(path);
        const server = await serverSpanFor(path);
        const { traceId } = server.spanContext();
        const outbound = callTo(`/out-${client}`);
        const traceContext = readTraceContext(outbound.headers);
        const clientSpan = spansInTrace(traceId).find(
          (span) =>
            span.kind === SpanKind.CLIENT &&
            span.spanContext().spanId === traceContext?.parentSpanId,
        );

        expect(traceparentsOf(outbound.rawHeaders)).toBe(1);
        expect(traceContext?.traceId).toBe(traceId);
        // The SDK's client span is the parent the callee sees, so the services
        // behind this one nest where the rest of its trace expects them.
        expect(clientSpan).toBeDefined();
        expect(outbound.headers["x-request-id"]).toBe(snapshot.traceId);
        expect(snapshot.traceId).toBe(asUuid(traceId));
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "http"),
        ).toHaveLength(1);
      });
    }

    describe.skipIf(!postgresReachable)("pg", () => {
      it("lets both record a query the driver still answers", async () => {
        expect(await call("/query/pg")).toBe(200);

        const snapshot = await snapshotFor("/query/pg");
        const server = await serverSpanFor("/query/pg");
        const [query] = spansOf(
          snapshot.traces as CompleteTraceEventNode[],
          "pg",
        );

        expect(query?.methodKey).toBe("SELECT");
        expect(
          spansInTrace(server.spanContext().traceId).some(
            (span) =>
              span.kind === SpanKind.CLIENT &&
              (span.attributes["db.system"] ??
                span.attributes["db.system.name"]) === "postgresql",
          ),
        ).toBe(true);
      });
    });
  },
);
