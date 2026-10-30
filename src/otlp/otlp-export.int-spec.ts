import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  FakeOtlpReceiver,
  ReceivedOtlpSpan,
  startFakeOtlpReceiver,
} from "../testing/fake-otlp-receiver.js";
import {
  listenOnLoopback,
  testObserveOptions,
} from "../testing/observe-harness.js";
import { SpanKind, STATUS_CODE_ERROR } from "./otlp-span.mapper.js";

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

@Controller()
class InventoryController {
  @Get("stock/:id")
  stock(@Param("id") id: string) {
    return { id, available: 3 };
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
 * would store.
 */
describe("ObserveModule: OTLP trace export", () => {
  let receiver: FakeOtlpReceiver;
  let gateway: INestApplication;
  let gatewayUrl = "";
  let inventory: INestApplication;

  beforeAll(async () => {
    receiver = await startFakeOtlpReceiver();

    inventory = await boot([InventoryController], [], {
      serviceId: "inventory",
      flushInterval: 1000,
      otlp: { endpoint: receiver.url, protocol: "http/json" },
    });
    inventoryUrl = await listenOnLoopback(inventory);

    gateway = await boot([GatewayController], [CheckoutService], {
      serviceId: "gateway-service-id",
      flushInterval: 1000,
      otlp: {
        endpoint: receiver.url,
        serviceName: "gateway",
        headers: { "x-api-key": "otlp-secret" },
      },
    });
    gatewayUrl = await listenOnLoopback(gateway);
  });

  afterAll(async () => {
    await gateway?.close();
    await inventory?.close();
    await receiver?.close();
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

describe("ObserveModule: OTLP export on shutdown", () => {
  it("exports what is still queued when the application closes", async () => {
    const receiver = await startFakeOtlpReceiver();
    // No periodic export before the close: everything goes in the final one.
    const app = await boot([InventoryController], [], {
      flushInterval: 60_000,
      otlp: { endpoint: receiver.url },
    });
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

  it("exports without Observe credentials, when the agent sends Observe nothing", async () => {
    // From this process's environment too, which credentials are read from.
    const saved = {
      key: process.env.OBSERVE_APP_KEY,
      secret: process.env.OBSERVE_APP_SECRET,
    };
    delete process.env.OBSERVE_APP_KEY;
    delete process.env.OBSERVE_APP_SECRET;
    const receiver = await startFakeOtlpReceiver();
    // The hosted collector takes nothing without a key and a secret, so the
    // agent starts no worker at all - and contacts it never.
    const app = await boot([InventoryController], [], {
      appKey: undefined,
      appSecret: undefined,
      endpoint: "https://observe-api.nestjs.com",
      flushInterval: 1000,
      otlp: { endpoint: receiver.url },
    });
    try {
      const url = await listenOnLoopback(app);
      await request(url).get("/stock/2").expect(200);

      await receiver.waitForSpan((span) => span.name === "GET /stock/:id");
    } finally {
      await app.close();
      await receiver.close();
      if (saved.key !== undefined) {
        process.env.OBSERVE_APP_KEY = saved.key;
      }
      if (saved.secret !== undefined) {
        process.env.OBSERVE_APP_SECRET = saved.secret;
      }
    }
  });

  it("sends nothing at all with enabled: false", async () => {
    const receiver = await startFakeOtlpReceiver();
    const app = await boot([InventoryController], [], {
      enabled: false,
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
