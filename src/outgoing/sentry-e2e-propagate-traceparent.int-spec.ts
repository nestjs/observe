// First, before anything that loads http, express or @nestjs/core: Sentry
// patches only what loads after it starts.
await vi.hoisted(async () => {
  const { startSentry } = await import("../testing/sentry-sdk.js");
  startSentry({ tracesSampleRate: 1, propagateTraceparent: true });
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
import { readTraceContext, w3cTraceIdOf } from "../utils/trace-context.util.js";

/** The trace id in a `sentry-trace` header: `<trace>-<span>[-<sampled>]`. */
const sentryTraceIdOf = (header: string | undefined) => header?.split("-")[0];

/**
 * The same Nest service on Sentry, with `propagateTraceparent` on - Sentry's
 * option to send W3C `traceparent` beside its own headers - adding Observe
 * with `openTelemetry` on, among services that run OpenTelemetry:
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Sentry + Observe) → inventory (OpenTelemetry)
 *
 * Two tracers then write `traceparent` on the same calls, each for a trace
 * of its own: Sentry, which starts first, writes it before the agent sees
 * the call, so the agent leaves it - and the call names Sentry's trace while
 * its `x-request-id` names Observe's. A combination that does not work: the
 * services after this one follow Sentry, not the gateway or Observe.
 */
describe("Sentry in a Nest service, sending traceparent, beside OpenTelemetry around it", () => {
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

  it("joins the gateway's trace while the call it makes goes out in the trace Sentry started", async () => {
    const received = await get(`${gateway.url}/orders/sentry-tp-joined`);

    const { traceId } = await serverSpan("gateway", "/orders/sentry-tp-joined");
    const snapshot = await orders.snapshotFor("/orders/sentry-tp-joined");
    const inventorySpan = await serverSpan(
      "inventory",
      "/stock/sentry-tp-joined",
    );
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    expect(snapshot.ti).toBe(asUuid(traceId));
    // One traceparent, Sentry's, naming a trace the gateway's is not.
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(readTraceContext(received.headers)?.traceId).toBe(sentryTraceId);
    expect(sentryTraceId).not.toBe(traceId);
    expect(inventorySpan.traceId).toBe(sentryTraceId);
    // And the agent's x-request-id disagrees with it.
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
  });

  it("names a request that starts at the Nest service by an id of its own, while the call it makes goes out in Sentry's trace", async () => {
    const received = await get(`${orders.url}/orders/sentry-tp-root`);

    const snapshot = await orders.snapshotFor("/orders/sentry-tp-root");
    const inventorySpan = await serverSpan(
      "inventory",
      "/stock/sentry-tp-root",
    );
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    expect(snapshot.ti[14]).toBe("7");
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(readTraceContext(received.headers)?.traceId).toBe(sentryTraceId);
    expect(sentryTraceId).not.toBe(w3cTraceIdOf(snapshot.ti));
    expect(inventorySpan.traceId).toBe(sentryTraceId);
    expect(received.headers["x-request-id"]).toBe(snapshot.ti);
  });
});
