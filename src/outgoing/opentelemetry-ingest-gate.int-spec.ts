import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, IncomingHttpHeaders, Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  CapturedOutput,
  captureOutput,
  listenOnLoopback,
  waitFor,
} from "../testing/observe-harness.js";
import { readTraceContext } from "../utils/trace-context.util.js";

// The W3C spec's own example, and the id Observe writes it as.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const TRACE_ID_AS_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";

let downstreamUrl = "";

@Injectable()
class CallerService {
  async call(label: string) {
    const response = await fetch(`${downstreamUrl}/${label}`);
    await response.text();
    return response.status;
  }
}

@Controller()
class CallerController {
  constructor(private readonly caller: CallerService) {}

  @Get("call/:label")
  call(@Param("label") label: string) {
    return this.caller.call(label);
  }
}

/**
 * OpenTelemetry interop works only while the agent's worker reports to NestJS
 * Observe and the collector takes what it sends - driven end to end, through
 * the real worker and a collector whose answers change under it.
 *
 * Each request arrives in the caller's W3C trace. With interop on, it is
 * reported under that trace's id and its outbound call carries `traceparent`.
 * With interop off, it gets a UUIDv7 of its own and the call carries
 * `x-request-id` alone - as with the option left off.
 */
describe("OpenTelemetry interop, beside the worker's ingest", () => {
  let collector: FakeCollector;
  let downstream: Server;
  let app: INestApplication;
  let url = "";
  let buffer: ObserveAgentSharedBuffer;
  let output: CapturedOutput;
  const received = new Map<string, IncomingHttpHeaders>();

  beforeAll(async () => {
    collector = await startFakeCollector();
    // Down to begin with, so not even a batch sent at start-up gets in.
    collector.answerWith({ message: "Service Unavailable" }, 503);
    downstream = createServer((req, res) => {
      received.set(req.url ?? "", req.headers);
      res.end("ok");
    });
    downstreamUrl = await listenOnLoopback(downstream);
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "gated-key",
          appSecret: "gated-secret",
          serviceId: "gated-app",
          endpoint: collector.url,
          // The agent's floor, so each phase below takes a second or two.
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
          openTelemetry: true,
        }),
      ],
      controllers: [CallerController],
      providers: [CallerService],
    })
    class GatedModule {}

    app = await NestFactory.create(GatedModule, {
      instrument: ObserveInstrument,
    });
    buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
    url = await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
    output?.restore();
    downstream?.closeAllConnections();
    await new Promise((resolve) => downstream?.close(resolve));
    await collector?.close();
  });

  /** A request in the caller's W3C trace; what its outbound call carried. */
  const call = async (label: string) => {
    const response = await fetch(`${url}/call/${label}`, {
      headers: { traceparent: TRACEPARENT },
    });
    expect(response.status).toBe(200);
    await response.text();
    const headers = received.get(`/${label}`);
    if (!headers) {
      throw new Error(`No call for ${label} reached the downstream service.`);
    }
    return headers;
  };

  /** Requests until `condition` holds, so every flush has a batch to send. */
  const withTraffic = async (
    condition: () => boolean,
    timeoutMs: number,
    what: string,
  ) => {
    let n = 0;
    const traffic = setInterval(() => {
      fetch(`${url}/call/traffic-${n++}`)
        .then((response) => response.text())
        .catch(() => undefined);
    }, 200);
    try {
      await waitFor(condition, timeoutMs, what);
    } finally {
      clearInterval(traffic);
    }
  };

  const expectOff = (headers: IncomingHttpHeaders) => {
    expect(headers).not.toHaveProperty("traceparent");
    expect(headers["x-request-id"]).not.toBe(TRACE_ID_AS_UUID);
    // A UUIDv7 of its own: version 7 at the version position.
    expect(String(headers["x-request-id"])[14]).toBe("7");
  };

  const expectOn = (headers: IncomingHttpHeaders) => {
    expect(readTraceContext(headers)?.traceId).toBe(TRACE_ID);
    expect(headers["x-request-id"]).toBe(TRACE_ID_AS_UUID);
  };

  it("stays off while no batch has got in", async () => {
    await withTraffic(
      () => collector.requests.length > 0,
      5000,
      "a batch to reach the collector",
    );

    expect(buffer.isIngesting()).toBe(false);
    expectOff(await call("collector-down"));
  });

  it("turns on once the collector accepts a batch", async () => {
    collector.answerWith({});
    await withTraffic(
      () => buffer.isIngesting(),
      5000,
      "the collector to accept a batch",
    );

    expectOn(await call("accepted"));
    expect(output.lines.join("")).toContain("OpenTelemetry interop is on");
  });

  it("turns off as soon as the collector refuses the credentials", async () => {
    collector.answerWith(
      { statusCode: 401, message: "Invalid API key or secret" },
      401,
    );
    await withTraffic(
      () => !buffer.isIngesting(),
      5000,
      "the refusal to reach the agent",
    );

    expectOff(await call("refused"));
    expect(output.lines.join("")).toContain(
      "OpenTelemetry interop is paused: the collector refused this app's credentials",
    );
  });

  it("turns back on with the next batch the collector accepts", async () => {
    collector.answerWith({});
    // The worker backs off after a refusal - one flush interval at first.
    await withTraffic(
      () => buffer.isIngesting(),
      10_000,
      "a batch to get in again",
    );

    expectOn(await call("accepted-again"));
  });
});

/**
 * An agent that reports nothing has no worker to get a batch in, so interop
 * never turns on, however long the application runs.
 */
describe.each([
  ["enabled: false", { enabled: false }],
  [
    "no credentials for the hosted collector",
    {
      appKey: undefined,
      appSecret: undefined,
      endpoint: "https://observe-api.nestjs.com",
    },
  ],
])("OpenTelemetry interop with %s", (_, reporting) => {
  let downstream: Server;
  let app: INestApplication;
  let url = "";
  let output: CapturedOutput;
  const received = new Map<string, IncomingHttpHeaders>();

  beforeAll(async () => {
    downstream = createServer((req, res) => {
      received.set(req.url ?? "", req.headers);
      res.end("ok");
    });
    downstreamUrl = await listenOnLoopback(downstream);
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "silent-key",
          appSecret: "silent-secret",
          serviceId: "silent-app",
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
          openTelemetry: true,
          ...reporting,
        }),
      ],
      controllers: [CallerController],
      providers: [CallerService],
    })
    class SilentModule {}

    app = await NestFactory.create(SilentModule, {
      instrument: ObserveInstrument,
    });
    url = await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app?.close();
    output?.restore();
    downstream?.closeAllConnections();
    await new Promise((resolve) => downstream?.close(resolve));
  });

  it("never reads or sends traceparent, and says why at start-up", async () => {
    // Long enough for several flushes, had there been a worker to send them.
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`${url}/call/silent-${i}`, {
        headers: { traceparent: TRACEPARENT },
      });
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (let i = 0; i < 4; i++) {
      const headers = received.get(`/silent-${i}`);
      expect(headers).not.toHaveProperty("traceparent");
      expect(String(headers?.["x-request-id"])[14]).toBe("7");
    }
    expect(output.lines.join("")).toContain("OpenTelemetry interop stays off");
  });
});
