import {
  ConsoleLogger,
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  FakeOtlpReceiver,
  ReceivedOtlpSpan,
  startFakeOtlpReceiver,
} from "../testing/fake-otlp-receiver.js";
import {
  CapturedOutput,
  captureOutput,
  listenOnLoopback,
  markIngesting,
  testObserveOptions,
  waitFor,
} from "../testing/observe-harness.js";
import { untilIngesting } from "../testing/opentelemetry-e2e.js";
import { SpanKind, STATUS_CODE_ERROR } from "./otlp-span.mapper.js";
import { OtlpTraceExporter } from "./otlp-trace-exporter.service.js";

let inventoryUrl = "";

@Injectable()
class CheckoutService {
  constructor(private readonly tracer: TracerService) {}

  checkout(id: string) {
    return this.tracer.createSpan("reserve stock", async (span) => {
      span.setTag("order.id", id);
      const response = await fetch(`${inventoryUrl}/stock/${id}`);
      return response.json();
    });
  }

  fail(): never {
    throw new Error("payment declined for card 4242 4242 4242 4242");
  }
}

@Controller()
class GatewayController {
  constructor(private readonly checkoutService: CheckoutService) {}

  @Get("checkout/:id")
  checkout(@Param("id") id: string) {
    return this.checkoutService.checkout(id);
  }

  @Get("fail")
  fail() {
    return this.checkoutService.fail();
  }
}

/**
 * What `untilIngesting` sends its warm-up traffic to: a route, so each
 * request is recorded and every flush has a batch to send.
 */
@Controller()
class HealthController {
  @Get("health")
  health() {
    return "ok";
  }
}

@Controller()
class InventoryController {
  @Get("stock/:id")
  stock(@Param("id") id: string) {
    return { id, available: 3 };
  }

  @Get("broken/:id")
  broken(): never {
    throw new Error("the warehouse is on fire");
  }
}

async function boot(
  controllers: Array<new (...args: any[]) => unknown>,
  providers: Array<new (...args: any[]) => unknown>,
  overrides: Partial<ObserveOptions>,
) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers,
    providers,
  })
  class AppModule {}

  return NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
}

/**
 * What every app here reports with: the real worker, to a collector of the
 * suite's own, which has to take a batch - and grant export in its reply -
 * before anything is exported. The agent's floor for the flush, so each
 * phase takes a second or two.
 */
const reporting = (
  collector: FakeCollector,
  overrides: Partial<ObserveOptions>,
): Partial<ObserveOptions> => ({
  endpoint: collector.url,
  flushInterval: 1000,
  openTelemetry: true,
  ...overrides,
});

/** Every span of one trace, walked up from a span to its root and down. */
const traceOf = (receiver: FakeOtlpReceiver, traceId: string) =>
  receiver.spans().filter((span) => span.traceId === traceId);

const childOf = (
  spans: ReceivedOtlpSpan[],
  parent: ReceivedOtlpSpan,
  name: string,
) => {
  const child = spans.find(
    (span) => span.parentSpanId === parent.spanId && span.name === name,
  );
  if (!child) {
    throw new Error(
      `No "${name}" under "${parent.name}". Spans: ${JSON.stringify(
        spans.map((span) => ({
          name: span.name,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
        })),
      )}`,
    );
  }
  return child;
};

/**
 * `otlp` end to end: two applications, each with its own agent, exporting
 * to one OTLP receiver - one as protobuf, one as JSON - while a request
 * crosses from one to the other over `fetch`. The receiver decodes with the
 * official schema, so what is asserted is what an OpenTelemetry backend
 * would store. Both report to a collector that grants every span.
 */
describe("ObserveModule: OTLP trace export, granted in full", () => {
  let collector: FakeCollector;
  let receiver: FakeOtlpReceiver;
  let gateway: INestApplication;
  let gatewayUrl = "";
  let inventory: INestApplication;

  beforeAll(async () => {
    collector = await startFakeCollector();
    collector.answerWith({ degraded: false, otlpExport: "full" });
    receiver = await startFakeOtlpReceiver();

    inventory = await boot(
      [InventoryController, HealthController],
      [],
      reporting(collector, {
        serviceId: "inventory",
        otlp: { endpoint: receiver.url, protocol: "http/json" },
      }),
    );
    inventoryUrl = await listenOnLoopback(inventory);

    gateway = await boot(
      [GatewayController, HealthController],
      [CheckoutService],
      reporting(collector, {
        serviceId: "gateway-service-id",
        otlp: {
          endpoint: receiver.url,
          serviceName: "gateway",
          headers: { "x-api-key": "otlp-secret" },
        },
      }),
    );
    gatewayUrl = await listenOnLoopback(gateway);

    await untilIngesting(inventory, inventoryUrl);
    await untilIngesting(gateway, gatewayUrl);
  }, 30_000);

  afterAll(async () => {
    await gateway?.close();
    await inventory?.close();
    await receiver?.close();
    await collector?.close();
  });

  it("asks the collector what the plan allows, on every batch", () => {
    expect(collector.requests.length).toBeGreaterThan(0);
    for (const { headers } of collector.requests) {
      expect(headers["x-observe-ingest-modes"]).toBe(
        "reduced, trimmed, paced, errors-only, otlp-export",
      );
    }
    expect(collector.violations).toEqual([]);
  });

  it("exports a request that crosses two services as one trace, nested at the hop", async () => {
    await request(gatewayUrl).get("/checkout/7").expect(200);

    const front = await receiver.waitForSpan(
      (span) =>
        span.name === "GET /checkout/:id" &&
        span.attributes["url.path"] === "/checkout/7",
    );
    const back = await receiver.waitForSpan(
      (span) =>
        span.traceId === front.traceId && span.name === "GET /stock/:id",
    );
    const spans = traceOf(receiver, front.traceId);

    expect(front.kind).toBe(SpanKind.SERVER);
    expect(front.parentSpanId).toBeUndefined();
    expect(front.attributes).toEqual(
      expect.objectContaining({
        "http.request.method": "GET",
        "http.route": "/checkout/:id",
        "http.response.status_code": 200,
      }),
    );

    const controller = childOf(spans, front, "GatewayController.checkout");
    const service = childOf(spans, controller, "CheckoutService.checkout");
    const manual = childOf(spans, service, "reserve stock");
    expect(manual.attributes["order.id"]).toBe("7");
    const call = spans.find(
      (span) =>
        span.parentSpanId === manual.spanId && span.kind === SpanKind.CLIENT,
    );
    expect(call?.name).toBe(`GET ${new URL(inventoryUrl).host}`);

    // The far side's server span sits under the near side's client span:
    // the traceparent the call carried named it.
    expect(back.parentSpanId).toBe(call?.spanId);
    expect(back.kind).toBe(SpanKind.SERVER);
    expect(back.flags).toBe(0x301);
    expect(childOf(spans, back, "InventoryController.stock")).toBeDefined();

    // Ordered on one clock: the call inside the span that made it.
    expect(BigInt(call!.startTimeUnixNano)).toBeGreaterThanOrEqual(
      BigInt(manual.startTimeUnixNano),
    );
    expect(BigInt(call!.endTimeUnixNano)).toBeLessThanOrEqual(
      BigInt(front.endTimeUnixNano),
    );
  });

  it("puts a request that arrived with a traceparent under the caller's span, in the caller's trace", async () => {
    const callerTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const callerSpanId = "00f067aa0ba902b7";
    await request(inventoryUrl)
      .get("/stock/caller")
      .set("traceparent", `00-${callerTraceId}-${callerSpanId}-01`)
      .expect(200);

    const server = await receiver.waitForSpan(
      (span) => span.attributes["url.path"] === "/stock/caller",
    );

    expect(server.traceId).toBe(callerTraceId);
    expect(server.parentSpanId).toBe(callerSpanId);
    expect(server.flags).toBe(0x301);
  });

  it("describes each service in its own encoding, with the headers it was given", async () => {
    await request(gatewayUrl).get("/checkout/8").expect(200);
    await receiver.waitForSpan((span) => span.name === "GET /stock/:id");

    const fromGateway = receiver.exports.find(
      (received) => received.resource["service.name"] === "gateway",
    );
    const fromInventory = receiver.exports.find(
      (received) => received.resource["service.name"] === "inventory",
    );

    expect(fromGateway?.encoding).toBe("protobuf");
    expect(fromGateway?.headers["content-type"]).toBe("application/x-protobuf");
    expect(fromGateway?.headers["content-encoding"]).toBe("gzip");
    expect(fromGateway?.headers["x-api-key"]).toBe("otlp-secret");
    expect(fromGateway?.scope.name).toBe("@nestjs/observe");
    expect(fromInventory?.encoding).toBe("json");
    expect(fromInventory?.headers["x-api-key"]).toBeUndefined();
    expect(fromInventory?.resource).toEqual(
      expect.objectContaining({
        "telemetry.sdk.name": "@nestjs/observe",
        "process.runtime.name": "nodejs",
      }),
    );
  });

  it("never traces its own exports, nor puts trace headers on them", async () => {
    await request(gatewayUrl).get("/checkout/9").expect(200);
    await receiver.waitForSpan(
      (span) => span.attributes["url.path"] === "/checkout/9",
    );

    for (const { headers } of receiver.requests) {
      expect(headers).not.toHaveProperty("x-request-id");
      expect(headers).not.toHaveProperty("traceparent");
    }
    const exportCalls = receiver
      .spans()
      .filter((span) =>
        String(span.attributes["url.full"] ?? "").includes("/v1/traces"),
      );
    expect(exportCalls).toEqual([]);
  });

  it("marks a failed request, with the exception redacted as the dashboard's copy is", async () => {
    await request(gatewayUrl).get("/fail").expect(500);

    const front = await receiver.waitForSpan(
      (span) => span.name === "GET /fail",
    );
    const handler = childOf(
      traceOf(receiver, front.traceId),
      front,
      "GatewayController.fail",
    );
    const thrower = childOf(
      traceOf(receiver, front.traceId),
      handler,
      "CheckoutService.fail",
    );

    expect(front.status?.code).toBe(STATUS_CODE_ERROR);
    expect(front.attributes["http.response.status_code"]).toBe(500);
    expect(front.attributes["error.type"]).toBe("Error");
    // The agent keeps the error itself on the operation's root span - a
    // deeper one may have been caught and handled - so the exception event
    // is there, and the span it passed through is only marked failed.
    const [exception] = handler.events ?? [];
    expect(exception?.name).toBe("exception");
    expect(exception?.attributes["exception.type"]).toBe("Error");
    expect(String(exception?.attributes["exception.stacktrace"])).toContain(
      "CheckoutService",
    );
    expect(String(exception?.attributes["exception.message"])).not.toContain(
      "4242 4242",
    );
    expect(thrower.status?.code).toBe(STATUS_CODE_ERROR);
    expect(thrower.events ?? []).toEqual([]);
  });

  it("retries an export the receiver turned away", async () => {
    const before = receiver.requests.length;
    receiver.answerNextWith(503, { "retry-after": "1" });
    await request(gatewayUrl).get("/checkout/10").expect(200);

    await receiver.waitForSpan(
      (span) => span.attributes["url.path"] === "/checkout/10",
      10_000,
    );
    expect(receiver.requests.length - before).toBeGreaterThanOrEqual(2);
  });
});

/**
 * What is exported follows the collector's word on the app's plan, read off
 * every accepted reply, and only while the agent reports to NestJS Observe -
 * driven through the real worker and a collector whose answers change under
 * it.
 */
describe("ObserveModule: OTLP export, as the collector grants it", () => {
  let collector: FakeCollector;
  let receiver: FakeOtlpReceiver;
  let app: INestApplication;
  let url = "";
  let buffer: ObserveAgentSharedBuffer;
  let exporter: OtlpTraceExporter;
  let output: CapturedOutput;
  const inserted: RequestSnapshot[] = [];

  beforeAll(async () => {
    collector = await startFakeCollector();
    // A collector that predates export: it accepts, and grants nothing.
    collector.answerWith({ degraded: false });
    receiver = await startFakeOtlpReceiver();
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "granted-key",
          appSecret: "granted-secret",
          serviceId: "granted-app",
          runtimeMetrics: false,
          forwardLogs: false,
          ...reporting(collector, {
            otlp: { endpoint: receiver.url, protocol: "http/json" },
          }),
        }),
      ],
      controllers: [InventoryController, HealthController],
    })
    class GrantedModule {}

    app = await NestFactory.create(GrantedModule, {
      instrument: ObserveInstrument,
      // An instance rather than the default: the apps above were created
      // with `logger: false`, which silences every logger until one is set.
      logger: new ConsoleLogger(),
    });
    buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
    exporter = app.get(OtlpTraceExporter, { strict: false });
    // Passed through, so the export decision is known to have been made.
    const insert = buffer.insertRequestSnapshot.bind(buffer);
    vi.spyOn(buffer, "insertRequestSnapshot").mockImplementation(
      (snapshot: RequestSnapshot) => {
        insert(snapshot);
        inserted.push(snapshot);
      },
    );
    url = await listenOnLoopback(app);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    output?.restore();
    await receiver?.close();
    await collector?.close();
  });

  /** Requests until `condition` holds, so every flush has a batch to send. */
  const withTraffic = async (
    condition: () => boolean,
    timeoutMs: number,
    what: string,
  ) => {
    let n = 0;
    const traffic = setInterval(() => {
      fetch(`${url}/stock/traffic-${n++}`)
        .then((response) => response.text())
        .catch(() => undefined);
    }, 200);
    try {
      await waitFor(condition, timeoutMs, what);
    } finally {
      clearInterval(traffic);
    }
  };

  /** The spans under `parent`, depth first. */
  const descendantsOf = (
    parent: ReceivedOtlpSpan,
    found: ReceivedOtlpSpan[] = [],
  ): ReceivedOtlpSpan[] => {
    for (const span of receiver.spans()) {
      if (span.parentSpanId === parent.spanId) {
        found.push(span);
        descendantsOf(span, found);
      }
    }
    return found;
  };

  /**
   * The spans exported for a request to `path`, once the buffer has decided
   * about it and the exporter has sent whatever that decision queued.
   */
  const exportedFor = async (path: string, status = 200) => {
    const response = await fetch(`${url}${path}`);
    expect(response.status).toBe(status);
    await response.text();
    await waitFor(
      () => inserted.some((s) => s.attributes?.originalUrl === path),
      5_000,
      `the snapshot for ${path} to reach the buffer`,
    );
    const internals = exporter as unknown as {
      sending: Promise<void> | null;
      queue: unknown[];
    };
    // Whatever is in flight, then whatever is still queued.
    await internals.sending;
    exporter.flush();
    await internals.sending;
    expect(internals.queue).toEqual([]);
    const server = receiver
      .spans()
      .find((span) => span.attributes["url.path"] === path);
    return server
      ? [server, ...descendantsOf(server)]
      : ([] as ReceivedOtlpSpan[]);
  };

  it("exports nothing while the collector's replies grant nothing, and says so once", async () => {
    await untilIngesting(app, url);

    expect(await exportedFor("/stock/ungranted")).toEqual([]);
    const said = output.lines
      .join("")
      .split("OTLP export is off: the collector did not grant it");
    expect(said).toHaveLength(2);
    expect(receiver.requests).toEqual([]);
  });

  it("exports every span once a reply grants it in full", async () => {
    collector.answerWith({ degraded: false, otlpExport: "full" });
    await withTraffic(
      () => buffer.otlpExportGrant() === "full",
      5_000,
      "a reply granting export",
    );

    const spans = await exportedFor("/stock/full");

    expect(spans.map((span) => span.name)).toEqual([
      "GET /stock/:id",
      "InventoryController.stock",
    ]);
    expect(output.lines.join("")).toContain(
      "OTLP export is on: every trace this app records goes to",
    );
  });

  it("exports what NestJS Observe keeps of a paced day, under a capped grant", async () => {
    collector.answerWith({
      degraded: true,
      paced: true,
      otlpExport: "capped",
    });
    await withTraffic(
      () => buffer.otlpExportGrant() === "capped" && buffer.isDegraded(),
      5_000,
      "a capped grant on a paced day",
    );

    // An ordinary request keeps its row, not its spans: its own span alone.
    const ordinary = await exportedFor("/stock/paced");
    // A failed one is notable, and keeps its whole tree.
    const failed = await exportedFor("/broken/paced", 500);

    expect(ordinary.map((span) => span.name)).toEqual(["GET /stock/:id"]);
    expect(failed.map((span) => span.name)).toEqual([
      "GET /broken/:id",
      "InventoryController.broken",
    ]);
    expect(output.lines.join("")).toContain(
      "OTLP export is on, capped by this app's plan",
    );
  });

  it("stops exporting as soon as the collector refuses the credentials", async () => {
    collector.answerWith(
      { statusCode: 401, message: "Invalid API key or secret" },
      401,
    );
    await withTraffic(
      () => !buffer.isIngesting(),
      5_000,
      "the refusal to reach the agent",
    );

    expect(await exportedFor("/stock/refused")).toEqual([]);
  });

  it("exports again with the next batch the collector accepts", async () => {
    collector.answerWith({ degraded: false, otlpExport: "full" });
    // The worker backs off after a refusal - one flush interval at first.
    await withTraffic(
      () => buffer.isIngesting() && buffer.otlpExportGrant() === "full",
      10_000,
      "a batch to get in again",
    );

    expect(
      (await exportedFor("/stock/accepted-again")).map((span) => span.name),
    ).toEqual(["GET /stock/:id", "InventoryController.stock"]);
    expect(collector.violations).toEqual([]);
  });
});

describe("ObserveModule: OTLP export on shutdown", () => {
  /** What a reply granting export in full records, without a collector. */
  const granted = (app: INestApplication) => {
    markIngesting(app);
    app.get(ObserveAgentSharedBuffer, { strict: false }).setOtlpExport("full");
  };

  it("exports what is still queued when the application closes", async () => {
    const receiver = await startFakeOtlpReceiver();
    // No periodic export before the close: everything goes in the final one.
    const app = await boot([InventoryController], [], {
      flushInterval: 60_000,
      openTelemetry: true,
      otlp: { endpoint: receiver.url },
    });
    granted(app);
    const url = await listenOnLoopback(app);
    try {
      await request(url).get("/stock/1").expect(200);
      expect(receiver.spans()).toEqual([]);

      await app.close();

      expect(receiver.spans().map((span) => span.name)).toEqual(
        expect.arrayContaining(["GET /stock/:id", "InventoryController.stock"]),
      );
    } finally {
      await receiver.close();
    }
  });

  it("exports nothing while the agent sends Observe nothing, as without credentials", async () => {
    // From this process's environment too, which credentials are read from.
    const saved = {
      key: process.env.OBSERVE_APP_KEY,
      secret: process.env.OBSERVE_APP_SECRET,
    };
    delete process.env.OBSERVE_APP_KEY;
    delete process.env.OBSERVE_APP_SECRET;
    const receiver = await startFakeOtlpReceiver();
    // The hosted collector takes nothing without a key and a secret, so the
    // agent starts no worker at all - and export, which runs only beside
    // reporting to Observe, does not start either, whatever it is told.
    const app = await boot([InventoryController], [], {
      appKey: undefined,
      appSecret: undefined,
      endpoint: "https://observe-api.nestjs.com",
      flushInterval: 1000,
      openTelemetry: true,
      otlp: { endpoint: receiver.url },
    });
    granted(app);
    let closed = false;
    try {
      const url = await listenOnLoopback(app);
      await request(url).get("/stock/2").expect(200);
      // Closing exports whatever is still queued, so after it nothing was.
      await app.close();
      closed = true;

      expect(receiver.requests).toEqual([]);
    } finally {
      if (!closed) {
        await app.close();
      }
      await receiver.close();
      if (saved.key !== undefined) {
        process.env.OBSERVE_APP_KEY = saved.key;
      }
      if (saved.secret !== undefined) {
        process.env.OBSERVE_APP_SECRET = saved.secret;
      }
    }
  });

  it("exports nothing without openTelemetry, whatever it is told", async () => {
    const receiver = await startFakeOtlpReceiver();
    const app = await boot([InventoryController], [], {
      otlp: { endpoint: receiver.url },
    });
    granted(app);
    const url = await listenOnLoopback(app);
    try {
      await request(url).get("/stock/3").expect(200);
      await app.close();

      expect(receiver.requests).toEqual([]);
    } finally {
      await receiver.close();
    }
  });

  it("sends nothing at all with enabled: false", async () => {
    const receiver = await startFakeOtlpReceiver();
    const app = await boot([InventoryController], [], {
      enabled: false,
      openTelemetry: true,
      otlp: { endpoint: receiver.url },
    });
    const url = await listenOnLoopback(app);
    try {
      await request(url).get("/stock/1").expect(200);
      await app.close();

      expect(receiver.requests).toEqual([]);
    } finally {
      await receiver.close();
    }
  });
});
