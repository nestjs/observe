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
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
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
import {
  ExportedSpan,
  OtlpReceiver,
  startOtlpReceiver,
} from "../testing/otlp-receiver.js";
import { readTraceContext } from "../utils/trace-context.util.js";

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
 * A team on OpenTelemetry everywhere, its Nest service included, adding
 * Observe to that service: the Node SDK and its auto-instrumentations start
 * before the application, as `--require ./tracing.js` starts them, and the
 * agent runs beside them with `openTelemetry` on.
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + OpenTelemetry + Observe) → inventory (OpenTelemetry)
 *
 * The gateway and inventory services run the SDK in processes of their own
 * and export over OTLP; the Nest service's SDK keeps its spans in memory.
 * End to end, through the agent's own worker and a collector that is down
 * when the service starts.
 */
describe("OpenTelemetry in a Nest service and the services around it", () => {
  let otlp: OtlpReceiver;
  let inventory: OpenTelemetryService;
  let gateway: OpenTelemetryService;
  let collector: FakeCollector;
  let app: INestApplication;
  let ordersUrl = "";

  beforeAll(async () => {
    otlp = await startOtlpReceiver();
    inventory = await startOpenTelemetryService({ name: "inventory", otlp });
    inventoryUrl = inventory.url;
    collector = await startFakeCollector();
    collector.answerWith({ message: "Service Unavailable" }, 503);
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
    });
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await app?.close();
    await inventory?.stop();
    await collector?.close();
    await otlp?.close();
    await shutdownOpenTelemetry();
  });

  /**
   * A request from outside any trace. The SDK instruments this process's
   * own `fetch` too, and would otherwise start a trace for each call the
   * suite makes and send its `traceparent` along.
   */
  const get = async (url: string) => {
    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as ReceivedRequest;
  };

  /** Every span in the Nest service's process, beside the others'. */
  const ordersSpans = (): ExportedSpan[] =>
    openTelemetrySpans
      .getFinishedSpans()
      .map((span) => exportedSpanOf(span, "orders"));

  const spans = () => [...otlp.spans, ...ordersSpans()];
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

  it("reports a new instance's first request under the gateway's trace, while the collector is down", async () => {
    const received = await get(`${gateway.url}/orders/first`);

    const { traceId } = await serverSpan("gateway", "/orders/first");
    const snapshot = await snapshotFor("/orders/first");

    // Nothing has got in: the collector has answered nothing but 503.
    expect(
      app.get(ObserveAgentSharedBuffer, { strict: false }).isIngesting(),
    ).toBe(false);
    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    // One traceparent on the call, the SDK's, in the same trace.
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(readTraceContext(received.headers)?.traceId).toBe(traceId);
  });

  // From here on the collector takes batches, as it does for most of a
  // service's life.
  it("stays in the gateway's trace once the collector takes a batch", async () => {
    collector.answerWith({});
    await untilIngesting(app, ordersUrl);

    const received = await get(`${gateway.url}/orders/accepted`);

    const { traceId } = await serverSpan("gateway", "/orders/accepted");
    const snapshot = await snapshotFor("/orders/accepted");
    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
  });

  it("reports a request under the gateway's trace, which the SDK continues around Observe's spans", async () => {
    const received = await get(`${gateway.url}/orders/joined`);

    const gatewaySpan = await serverSpan("gateway", "/orders/joined");
    const { traceId } = gatewaySpan;
    const gatewayCall = await clientSpanIn("gateway", traceId);
    const ordersSpan = await serverSpan("orders", "/orders/joined");
    const ordersCall = await clientSpanIn("orders", traceId);
    const inventorySpan = await serverSpan("inventory", "/stock/joined");
    const snapshot = await snapshotFor("/orders/joined");

    expect(snapshot.ti).toBe(asUuid(traceId));
    // OpenTelemetry's trace is whole: gateway → orders → inventory.
    expect(ordersSpan.traceId).toBe(traceId);
    expect(ordersSpan.parentSpanId).toBe(gatewayCall.spanId);
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
    // One traceparent on the call, the SDK's, and the agent's x-request-id.
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    // And Observe still records the call itself.
    expect(wireSpansOf(snapshot.t, "http")).toHaveLength(1);
    expect(collector.violations).toEqual([]);
  });

  it("reports a request that starts at the Nest service under the trace its SDK started", async () => {
    const received = await get(`${ordersUrl}/orders/root`);

    const ordersSpan = await serverSpan("orders", "/orders/root");
    const { traceId } = ordersSpan;
    const ordersCall = await clientSpanIn("orders", traceId);
    const inventorySpan = await serverSpan("inventory", "/stock/root");
    const snapshot = await snapshotFor("/orders/root");

    expect(ordersSpan.parentSpanId).toBeUndefined();
    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
  });
});
