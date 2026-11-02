// First, before anything that loads http, express or @nestjs/core: Sentry
// patches only what loads after it starts.
await vi.hoisted(async () => {
  const { startSentry } = await import("../testing/sentry-sdk.js");
  startSentry({ tracesSampleRate: 1 });
});

import { SentryModule } from "@sentry/nestjs/setup";
import {
  asUuid,
  countHeader,
  ReceivedRequest,
  serverSpanFrom,
  wireSpansOf,
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
import {
  readTraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";

/** The trace id in a `sentry-trace` header: `<trace>-<span>[-<sampled>]`. */
const sentryTraceIdOf = (header: string | undefined) => header?.split("-")[0];

/**
 * A Nest service on Sentry, with tracing on as Sentry's NestJS guide sets it
 * up - `Sentry.init()` first, `SentryModule.forRoot()` in the application
 * module - and otherwise its defaults, adding Observe with `openTelemetry`
 * on, among services that run OpenTelemetry:
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Sentry + Observe) → inventory (OpenTelemetry)
 *
 * Sentry 11 leaves the OpenTelemetry API alone unless told otherwise, and
 * sends only its own `sentry-trace` and `baggage`: the agent cannot see
 * Sentry's spans, and nothing of Sentry's gets in its way. It joins the
 * OpenTelemetry trace as it would with no Sentry, and Sentry keeps a trace
 * of its own for the request.
 */
describe("Sentry in a Nest service, with its defaults, beside OpenTelemetry around it", () => {
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

  it("reports a request the gateway traced under the gateway's trace, which the inventory service continues, while Sentry keeps its own", async () => {
    const received = await get(`${gateway.url}/orders/sentry-joined`);

    const { traceId } = await serverSpan("gateway", "/orders/sentry-joined");
    const snapshot = await orders.snapshotFor("/orders/sentry-joined");
    const [call] = wireSpansOf(snapshot.t, "http");
    const inventorySpan = await serverSpan("inventory", "/stock/sentry-joined");

    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
    expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
    expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    // Sentry traced the call too - in a trace it started, since it does not
    // read traceparent.
    const sentryTraceId = sentryTraceIdOf(received.headers["sentry-trace"]);
    expect(sentryTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sentryTraceId).not.toBe(traceId);
    expect(orders.collector.violations).toEqual([]);
  });

  it("starts a W3C trace from the id it gives a request that arrives in none, which Sentry does not share", async () => {
    const received = await get(`${orders.url}/orders/sentry-root`);

    const snapshot = await orders.snapshotFor("/orders/sentry-root");
    const inventorySpan = await serverSpan("inventory", "/stock/sentry-root");

    expect(snapshot.ti[14]).toBe("7");
    expect(inventorySpan.traceId).toBe(w3cTraceIdOf(snapshot.ti));
    expect(readTraceContext(received.headers)?.traceId).toBe(
      w3cTraceIdOf(snapshot.ti),
    );
    expect(sentryTraceIdOf(received.headers["sentry-trace"])).not.toBe(
      w3cTraceIdOf(snapshot.ti),
    );
  });
});
