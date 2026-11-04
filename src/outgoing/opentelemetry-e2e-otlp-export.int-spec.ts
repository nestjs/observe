import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { randomBytes } from "node:crypto";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback } from "../testing/observe-harness.js";
import {
  asUuid,
  clientSpanFrom,
  pathOf,
  ReceivedRequest,
  serverSpanFrom,
  snapshotAt,
  spanFrom,
  untilIngesting,
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
import { w3cTraceIdOf } from "../utils/trace-context.util.js";

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
 * What a team means by "send our Nest service's traces to the backend we
 * already have": the services around the Nest one run the OpenTelemetry SDK
 * and export to their OpenTelemetry backend, and the Nest service runs the
 * agent alone, with `openTelemetry` on and `otlp` pointed at that backend.
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Observe) → inventory (OpenTelemetry)
 *
 * End to end: the agent's worker reports to a collector that grants export
 * for the app's plan, and every service's spans are read back from the one
 * backend they all export to - which is where a team looks at the trace.
 */
describe("Observe's spans in the OpenTelemetry backend of the services around a Nest service", () => {
  let otlp: OtlpReceiver;
  let collector: FakeCollector;
  let inventory: OpenTelemetryService;
  let gateway: OpenTelemetryService;
  let app: INestApplication;
  let ordersUrl = "";

  beforeAll(async () => {
    otlp = await startOtlpReceiver();
    collector = await startFakeCollector();
    collector.answerWith({ degraded: false, otlpExport: "full" });
    inventory = await startOpenTelemetryService({ name: "inventory", otlp });
    inventoryUrl = inventory.url;

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "e2e-key",
          appSecret: "e2e-secret",
          serviceId: "orders",
          endpoint: collector.url,
          // The agent's floor, so the first batch goes within a second.
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
          openTelemetry: true,
          // JSON, which the backend here reads; the default is protobuf.
          otlp: { endpoint: otlp.tracesUrl, protocol: "http/json" },
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
    await untilIngesting(app, ordersUrl);
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await app?.close();
    await inventory?.stop();
    await collector?.close();
    await otlp?.close();
  });

  const spans = () => otlp.spans;

  /** The orders service's server span for a request to `path`. */
  const ordersServerSpan = (path: string) =>
    spanFrom(
      spans,
      (span) =>
        span.service === "orders" &&
        span.kind === "server" &&
        pathOf(span) === path,
      `the orders service's server span for ${path}`,
    );

  /** Whether `span` sits under `ancestor`, through the spans of its trace. */
  const isUnder = (span: ExportedSpan, ancestor: ExportedSpan): boolean => {
    let parentId = span.parentSpanId;
    for (let hops = 0; parentId !== undefined && hops < 50; hops++) {
      if (parentId === ancestor.spanId) {
        return true;
      }
      parentId = spans().find(
        (candidate) =>
          candidate.traceId === span.traceId && candidate.spanId === parentId,
      )?.parentSpanId;
    }
    return false;
  };

  it("nests the Nest service's spans between the services around it, in one trace", async () => {
    const response = await fetch(`${gateway.url}/orders/one`);
    expect(response.status).toBe(200);
    await response.text();

    const gatewayServer = await serverSpanFrom(spans, "gateway", "/orders/one");
    const { traceId } = gatewayServer;
    const gatewayClient = await clientSpanFrom(spans, "gateway", traceId);
    const ordersServer = await ordersServerSpan("/orders/one");
    const ordersClient = await clientSpanFrom(spans, "orders", traceId);
    const inventoryServer = await serverSpanFrom(
      spans,
      "inventory",
      "/stock/one",
    );

    // One trace, from the gateway down to the inventory service.
    expect(ordersServer.traceId).toBe(traceId);
    expect(inventoryServer.traceId).toBe(traceId);
    // Each hop under the span that made the call: the gateway's call is
    // the parent of the Nest service's server span, and the Nest service's
    // own call the parent of the inventory service's.
    expect(ordersServer.parentSpanId).toBe(gatewayClient.spanId);
    expect(inventoryServer.parentSpanId).toBe(ordersClient.spanId);
    // And inside the Nest service, the call under the request it served,
    // through the handler that made it.
    expect(isUnder(ordersClient, ordersServer)).toBe(true);
    expect(
      spans().some(
        (span) =>
          span.service === "orders" &&
          span.name === "OrdersController.order" &&
          span.parentSpanId === ordersServer.spanId,
      ),
    ).toBe(true);

    // The same request in NestJS Observe, under the same trace id.
    const snapshot = await snapshotAt(
      collector,
      (candidate) => candidate.a?.ou === "/orders/one",
      "the snapshot for /orders/one at the collector",
    );
    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(collector.violations).toEqual([]);
  });

  it("starts the trace for a request that arrives in none, and the inventory service continues it", async () => {
    const response = await fetch(`${ordersUrl}/orders/two`);
    expect(response.status).toBe(200);
    await response.text();

    const ordersServer = await ordersServerSpan("/orders/two");
    const ordersClient = await clientSpanFrom(
      spans,
      "orders",
      ordersServer.traceId,
    );
    const inventoryServer = await serverSpanFrom(
      spans,
      "inventory",
      "/stock/two",
    );
    const snapshot = await snapshotAt(
      collector,
      (candidate) => candidate.a?.ou === "/orders/two",
      "the snapshot for /orders/two at the collector",
    );

    expect(ordersServer.parentSpanId).toBeUndefined();
    expect(ordersServer.traceId).toBe(w3cTraceIdOf(snapshot.ti));
    expect(inventoryServer.traceId).toBe(ordersServer.traceId);
    expect(inventoryServer.parentSpanId).toBe(ordersClient.spanId);
  });

  it("exports none of a request its caller sampled out, as the services around it export none", async () => {
    const traceId = randomBytes(16).toString("hex");
    const sampledOut = await fetch(`${gateway.url}/orders/three`, {
      headers: {
        traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-00`,
      },
    });
    expect(sampledOut.status).toBe(200);
    await sampledOut.text();
    // Still reported to NestJS Observe, which samples by its own rules.
    await snapshotAt(
      collector,
      (candidate) => candidate.a?.ou === "/orders/three",
      "the snapshot for /orders/three at the collector",
    );

    // A request sampled in after it: once every service's spans for that
    // one are in, any span exported for the first would be too.
    const after = await fetch(`${gateway.url}/orders/three-after`);
    await after.text();
    await serverSpanFrom(spans, "gateway", "/orders/three-after");
    await ordersServerSpan("/orders/three-after");
    await serverSpanFrom(spans, "inventory", "/stock/three-after");

    expect(spans().filter((span) => span.traceId === traceId)).toEqual([]);
  });
});
