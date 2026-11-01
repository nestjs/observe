// First, before anything that loads http, express or @nestjs/core: dd-trace
// patches only what loads after it starts.
const { agent, untracedFetch } = await vi.hoisted(async () => {
  const { startDatadogTracer } = await import("../testing/datadog-tracer.js");
  return startDatadogTracer({ tracerProvider: true });
});

import { datadogRuns } from "../testing/datadog-agent.js";
import { startDatadogService } from "../testing/datadog-service.js";
import {
  asUuid,
  clientSpanFrom,
  countHeader,
  ReceivedRequest,
  serverSpanFrom,
} from "../testing/opentelemetry-e2e.js";
import {
  OrdersService,
  startOrdersService,
} from "../testing/orders-service.js";
import type { TracedService } from "../testing/traced-service.js";

/**
 * A team on Datadog everywhere, its Nest service included, adding Observe to
 * that service - where the service registers dd-trace's OpenTelemetry
 * `TracerProvider`, as Datadog documents for an application that uses the
 * OpenTelemetry API, and does nothing else for it (`DD_TRACE_OTEL_ENABLED`,
 * which Datadog's guide sets as well, is left unset):
 *
 *   const tracer = require("dd-trace").init();
 *   new tracer.TracerProvider().register();
 *
 *   client → gateway (dd-trace) → orders (Nest + dd-trace + Observe) → inventory (dd-trace)
 *
 * The provider hands dd-trace's active span to the OpenTelemetry API, which
 * is where the agent looks for a tracer running beside it - so it follows
 * dd-trace as it follows the OpenTelemetry SDK. `datadog-e2e-in-process`
 * runs the same requests without it.
 */
describe.skipIf(!datadogRuns)(
  "dd-trace in a Nest service, with its TracerProvider registered, and in the services around it",
  () => {
    let inventory: TracedService;
    let orders: OrdersService;
    let gateway: TracedService;
    let datadogOnlyGateway: TracedService;

    beforeAll(async () => {
      inventory = await startDatadogService({ name: "inventory", agent });
      orders = await startOrdersService({ inventoryUrl: inventory.url });
      gateway = await startDatadogService({
        name: "gateway",
        agent,
        next: orders.url,
      });
      datadogOnlyGateway = await startDatadogService({
        name: "datadog-only-gateway",
        agent,
        next: orders.url,
        propagationStyle: "datadog",
      });
      await orders.untilIngesting();
    }, 60_000);

    afterAll(async () => {
      await datadogOnlyGateway?.stop();
      await gateway?.stop();
      await orders?.close();
      await inventory?.stop();
      await agent?.close();
    });

    const get = async (url: string) => {
      const response = await untracedFetch(url);
      expect(response.status).toBe(200);
      return (await response.json()) as ReceivedRequest;
    };

    const spans = () => agent.spans;
    const serverSpan = (service: string, path: string) =>
      serverSpanFrom(spans, service, path);

    it("reports a request under the gateway's trace, which dd-trace continues around Observe's spans", async () => {
      const received = await get(`${gateway.url}/orders/tp-one`);

      const { traceId } = await serverSpan("gateway", "/orders/tp-one");
      const ordersSpan = await serverSpan("orders", "/orders/tp-one");
      const ordersCall = await clientSpanFrom(spans, "orders", traceId);
      const inventorySpan = await serverSpan("inventory", "/stock/tp-one");
      const snapshot = await orders.snapshotFor("/orders/tp-one");

      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(ordersSpan.traceId).toBe(traceId);
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
      expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(orders.collector.violations).toEqual([]);
    });

    it("reports a request that starts at the Nest service under the trace dd-trace started", async () => {
      const received = await get(`${orders.url}/orders/tp-root`);

      const ordersSpan = await serverSpan("orders", "/orders/tp-root");
      const { traceId } = ordersSpan;
      const ordersCall = await clientSpanFrom(spans, "orders", traceId);
      const inventorySpan = await serverSpan("inventory", "/stock/tp-root");
      const snapshot = await orders.snapshotFor("/orders/tp-root");

      expect(ordersSpan.parentSpanId).toBeUndefined();
      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
      expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
    });

    it("follows dd-trace into a trace the caller sent only Datadog's headers for", async () => {
      await get(`${datadogOnlyGateway.url}/orders/tp-datadog-only`);

      const { traceId } = await serverSpan(
        "datadog-only-gateway",
        "/orders/tp-datadog-only",
      );
      const ordersSpan = await serverSpan("orders", "/orders/tp-datadog-only");
      const snapshot = await orders.snapshotFor("/orders/tp-datadog-only");

      // The agent reads no x-datadog-* header itself; dd-trace did, and the
      // agent goes by dd-trace's span.
      expect(ordersSpan.traceId).toBe(traceId);
      expect(snapshot.ti).toBe(asUuid(traceId));
    });
  },
);
