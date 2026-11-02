// First, before anything that loads http, express or @nestjs/core: Sentry
// patches only what loads after it starts.
await vi.hoisted(async () => {
  const { startSentry } = await import("../testing/sentry-sdk.js");
  startSentry({ tracesSampleRate: 1, enableOpenTelemetrySetup: true });
});

import { SentryModule } from "@sentry/nestjs/setup";
import {
  asUuid,
  countHeader,
  ReceivedRequest,
  serverSpanFrom,
} from "../testing/opentelemetry-e2e.js";
import {
  OpenTelemetryService,
  startOpenTelemetryService,
} from "../testing/opentelemetry-service.js";
import {
  OrdersService,
  startOrdersService,
} from "../testing/orders-service.js";
import { OtlpReceiver, startOtlpReceiver } from "../testing/otlp-receiver.js";
/** The trace id in a `sentry-trace` header: `<trace>-<span>[-<sampled>]`. */
const sentryTraceIdOf = (header: string | undefined) => header?.split("-")[0];

/**
 * The same Nest service on Sentry, with `enableOpenTelemetrySetup` on, which
 * registers Sentry's tracer, context manager and propagator with the
 * OpenTelemetry API, adding Observe with `openTelemetry` on, among services
 * that run OpenTelemetry:
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Sentry + Observe) → inventory (OpenTelemetry)
 *
 * The agent then follows Sentry's spans, as it follows any tracer registered
 * there - but Sentry continues a trace only from its own headers, and its
 * propagator names `traceparent` among those it writes while writing it only
 * with `propagateTraceparent` on, so the agent leaves the header to Sentry
 * and no one writes it. Observe and Sentry share a trace; the services
 * around them are in other ones.
 */
describe("Sentry in a Nest service, registered with the OpenTelemetry API, beside OpenTelemetry around it", () => {
  let otlp: OtlpReceiver;
  let inventory: OpenTelemetryService;
  let orders: OrdersService;
  let gateway: OpenTelemetryService;

  beforeAll(async () => {
    otlp = await startOtlpReceiver();
    inventory = await startOpenTelemetryService({ name: "inventory", otlp });
    orders = await startOrdersService({
      inventoryUrl: inventory.url,
      imports: [SentryModule.forRoot()],
    });
    gateway = await startOpenTelemetryService({
      name: "gateway",
      otlp,
      next: orders.url,
    });
    await orders.untilIngesting();
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await orders?.close();
    await inventory?.stop();
    await otlp?.close();
  });

  const get = async (url: string) => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    return (await response.json()) as ReceivedRequest;
  };

  const serverSpan = (service: string, path: string) =>
    serverSpanFrom(() => otlp.spans, service, path);

  it("reports a request that starts at the Nest service under Sentry's trace, and sends no traceparent on", async () => {
    const received = await get(`${orders.url}/orders/sentry-otel-root`);

    const snapshot = await orders.snapshotFor("/orders/sentry-otel-root");
    const inventorySpan = await serverSpan(
      "inventory",
      "/stock/sentry-otel-root",
    );
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    expect(sentryTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(snapshot.ti).toBe(asUuid(sentryTraceId!));
    expect(received.headers["x-request-id"]).toBe(asUuid(sentryTraceId!));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(0);
    expect(inventorySpan.parentSpanId).toBeUndefined();
    expect(inventorySpan.traceId).not.toBe(sentryTraceId);
  });

  it("reports a request the gateway traced under a trace Sentry started for it instead", async () => {
    const received = await get(`${gateway.url}/orders/sentry-otel-joined`);

    const { traceId } = await serverSpan(
      "gateway",
      "/orders/sentry-otel-joined",
    );
    const snapshot = await orders.snapshotFor("/orders/sentry-otel-joined");
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    // Sentry does not read the gateway's traceparent, and the agent goes by
    // Sentry's span: the gateway's trace ends at its call to this service.
    expect(snapshot.ti).toBe(asUuid(sentryTraceId!));
    expect(snapshot.ti).not.toBe(asUuid(traceId));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(0);
  });
});
