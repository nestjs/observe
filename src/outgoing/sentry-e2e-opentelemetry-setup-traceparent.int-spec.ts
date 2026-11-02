// First, before anything that loads http, express or @nestjs/core: Sentry
// patches only what loads after it starts.
await vi.hoisted(async () => {
  const { startSentry } = await import("../testing/sentry-sdk.js");
  startSentry({
    tracesSampleRate: 1,
    enableOpenTelemetrySetup: true,
    propagateTraceparent: true,
  });
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
 * The same Nest service on Sentry, with both `enableOpenTelemetrySetup` and
 * `propagateTraceparent` on, adding Observe with `openTelemetry` on, among
 * services that run OpenTelemetry:
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Sentry + Observe) → inventory (OpenTelemetry)
 *
 * The agent follows Sentry's spans and leaves `traceparent` to Sentry, which
 * now writes it: a trace that starts at this service is one trace in all
 * three. One that starts before it still is not, since Sentry continues a
 * trace only from its own headers.
 */
describe("Sentry in a Nest service, registered with the OpenTelemetry API and sending traceparent, beside OpenTelemetry around it", () => {
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

  it("reports a request that starts at the Nest service under Sentry's trace, which the inventory service continues", async () => {
    const received = await get(`${orders.url}/orders/sentry-both-root`);

    const snapshot = await orders.snapshotFor("/orders/sentry-both-root");
    const inventorySpan = await serverSpan(
      "inventory",
      "/stock/sentry-both-root",
    );
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    expect(sentryTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(snapshot.ti).toBe(asUuid(sentryTraceId!));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(inventorySpan.traceId).toBe(sentryTraceId);
    expect(received.headers["x-request-id"]).toBe(asUuid(sentryTraceId!));
    expect(orders.collector.violations).toEqual([]);
  });

  it("reports a request the gateway traced under a trace Sentry started for it instead, which the inventory service continues", async () => {
    const received = await get(`${gateway.url}/orders/sentry-both-joined`);

    const { traceId } = await serverSpan(
      "gateway",
      "/orders/sentry-both-joined",
    );
    const snapshot = await orders.snapshotFor("/orders/sentry-both-joined");
    const inventorySpan = await serverSpan(
      "inventory",
      "/stock/sentry-both-joined",
    );
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);

    expect(snapshot.ti).toBe(asUuid(sentryTraceId!));
    expect(snapshot.ti).not.toBe(asUuid(traceId));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(inventorySpan.traceId).toBe(sentryTraceId);
  });
});
