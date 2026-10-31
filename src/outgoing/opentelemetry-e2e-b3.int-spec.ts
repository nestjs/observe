// Read by the SDK as it starts - which importing the helper below does - so
// it has to be set before any import runs.
vi.hoisted(() => {
  process.env.OTEL_PROPAGATORS = "b3multi";
});

// First, before anything that loads http, express or @nestjs/core: the SDK's
// instrumentations patch only what loads after it starts.
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
import { context, propagation } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback } from "../testing/observe-harness.js";
import {
  asUuid,
  clientSpanFrom,
  countHeader,
  exportedSpanOf,
  ReceivedRequest,
  serverSpanFrom,
  snapshotAt,
  untilIngesting,
  wireSpansOf,
} from "../testing/opentelemetry-e2e.js";
import {
  OpenTelemetryService,
  startOpenTelemetryService,
} from "../testing/opentelemetry-service.js";
import { OtlpReceiver, startOtlpReceiver } from "../testing/otlp-receiver.js";
import { readTraceContext, w3cSpanIdOf } from "../utils/trace-context.util.js";

let inventoryUrl = "";

@Injectable()
class InventoryClient {
  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

@Controller()
class OrdersController {
  constructor(private readonly inventory: InventoryClient) {}

  @Get("health")
  health() {
    return "ok";
  }

  @Get("orders/:id")
  order(@Param("id") id: string) {
    return this.inventory.stock(id);
  }
}

/**
 * OpenTelemetry everywhere, propagating B3 rather than W3C Trace Context -
 * `OTEL_PROPAGATORS=b3multi`, what a Zipkin backend, or a mesh that traces
 * with Zipkin headers, asks of the services in it.
 *
 *   client → gateway (OpenTelemetry, B3) → orders (Nest + OpenTelemetry, B3 + Observe) → inventory (OpenTelemetry, B3)
 *
 * No `traceparent` comes in, so the agent learns the trace from the span
 * the SDK opened for the request. The SDK writes no `traceparent` either, so
 * the agent writes one, beside the SDK's B3 headers and naming the same
 * trace, for any service down the line that reads W3C Trace Context.
 */
describe("OpenTelemetry with B3 propagation, in a Nest service and the services around it", () => {
  let otlp: OtlpReceiver;
  let inventory: OpenTelemetryService;
  let gateway: OpenTelemetryService;
  let collector: FakeCollector;
  let app: INestApplication;
  let ordersUrl = "";

  beforeAll(async () => {
    otlp = await startOtlpReceiver();
    inventory = await startOpenTelemetryService({
      name: "inventory",
      otlp,
      propagators: "b3multi",
    });
    inventoryUrl = inventory.url;
    collector = await startFakeCollector();
    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "e2e-key",
          appSecret: "e2e-secret",
          serviceId: "orders",
          endpoint: collector.url,
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
          openTelemetry: true,
        }),
      ],
      controllers: [OrdersController],
      providers: [InventoryClient],
    })
    class OrdersModule {}

    app = await NestFactory.create(OrdersModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    ordersUrl = await listenOnLoopback(app);
    gateway = await startOpenTelemetryService({
      name: "gateway",
      otlp,
      next: ordersUrl,
      propagators: "b3multi",
    });
    await untilIngesting(app, ordersUrl);
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await app?.close();
    await inventory?.stop();
    await collector?.close();
    await otlp?.close();
    await shutdownOpenTelemetry();
  });

  /** A request from outside any trace - see the in-process SDK suite. */
  const get = async (url: string) => {
    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ReceivedRequest;
  };

  const spans = () => [
    ...otlp.spans,
    ...openTelemetrySpans
      .getFinishedSpans()
      .map((span) => exportedSpanOf(span, "orders")),
  ];
  const serverSpan = (service: string, path: string) =>
    serverSpanFrom(spans, service, path);
  const clientSpanIn = (service: string, traceId: string) =>
    clientSpanFrom(spans, service, traceId);

  const snapshotFor = (path: string) =>
    snapshotAt(
      collector,
      (snapshot) => snapshot.a?.ou === path,
      `the snapshot for ${path} at the collector`,
    );

  it("propagates B3 in this process, and no traceparent", () => {
    expect(propagation.fields()).toContain("x-b3-traceid");
    expect(propagation.fields()).not.toContain("traceparent");
  });

  it("reports a request under the trace its B3 headers named, and adds a traceparent in that trace beside the SDK's B3", async () => {
    const received = await get(`${gateway.url}/orders/b3`);

    const { traceId } = await serverSpan("gateway", "/orders/b3");
    const gatewayCall = await clientSpanIn("gateway", traceId);
    const ordersSpan = await serverSpan("orders", "/orders/b3");
    const ordersCall = await clientSpanIn("orders", traceId);
    const inventorySpan = await serverSpan("inventory", "/stock/b3");
    const snapshot = await snapshotFor("/orders/b3");
    const [call] = wireSpansOf(snapshot.t, "http");

    expect(snapshot.ti).toBe(asUuid(traceId));
    // The SDK's B3 headers carry its trace on, gateway → orders → inventory.
    expect(ordersSpan.parentSpanId).toBe(gatewayCall.spanId);
    expect(received.headers["x-b3-traceid"]).toBe(traceId);
    expect(received.headers["x-b3-spanid"]).toBe(ordersCall.spanId);
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
    // The agent's traceparent names the same trace, under its own span.
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(readTraceContext(received.headers)).toMatchObject({
      traceId,
      parentSpanId: w3cSpanIdOf(String(call.s)),
      sampled: true,
    });
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    expect(collector.violations).toEqual([]);
  });

  it("reports a request that starts at the Nest service under the trace its SDK started", async () => {
    const received = await get(`${ordersUrl}/orders/b3-root`);

    const ordersSpan = await serverSpan("orders", "/orders/b3-root");
    const { traceId } = ordersSpan;
    const inventorySpan = await serverSpan("inventory", "/stock/b3-root");
    const snapshot = await snapshotFor("/orders/b3-root");

    expect(ordersSpan.parentSpanId).toBeUndefined();
    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(inventorySpan.traceId).toBe(traceId);
    expect(readTraceContext(received.headers)?.traceId).toBe(traceId);
  });
});
