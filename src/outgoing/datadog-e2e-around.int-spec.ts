import {
  DatadogAgent,
  datadogRuns,
  startDatadogAgent,
} from "../testing/datadog-agent.js";
import { startDatadogService } from "../testing/datadog-service.js";
import {
  asUuid,
  clientSpanFrom,
  countHeader,
  ReceivedRequest,
  serverSpanFrom,
  wireSpansOf,
} from "../testing/opentelemetry-e2e.js";
import {
  OrdersService,
  startOrdersService,
} from "../testing/orders-service.js";
import type { TracedService } from "../testing/traced-service.js";
import { w3cSpanIdOf, w3cTraceIdOf } from "../utils/trace-context.util.js";

/**
 * A team on Datadog adding a Nest service that runs Observe and no dd-trace:
 * the services around it run dd-trace the zero-code way, in processes of
 * their own, with its defaults - which send W3C Trace Context beside
 * Datadog's own headers - and send their spans to an Agent.
 *
 *   client → gateway (dd-trace) → orders (Nest + Observe) → inventory (dd-trace)
 *
 * End to end, as the OpenTelemetry suites run: the agent's own worker sends
 * to a collector, and each tool's part of a request is read back from where
 * it landed - the batch for Observe, the Agent for Datadog.
 */
describe.skipIf(!datadogRuns)(
  "Datadog in the services around a Nest service, none in it",
  () => {
    let agent: DatadogAgent;
    let inventory: TracedService;
    let orders: OrdersService;
    let gateway: TracedService;
    let datadogOnlyGateway: TracedService;

    beforeAll(async () => {
      agent = await startDatadogAgent();
      inventory = await startDatadogService({ name: "inventory", agent });
      orders = await startOrdersService({ inventoryUrl: inventory.url });
      gateway = await startDatadogService({
        name: "gateway",
        agent,
        next: orders.url,
      });
      // How a service with only Datadog's own headers on calls - a team that
      // turned W3C off, or a tracer older than its default.
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
      const response = await fetch(url);
      expect(response.status).toBe(200);
      return (await response.json()) as ReceivedRequest;
    };

    const spans = () => agent.spans;
    const serverSpan = (service: string, path: string) =>
      serverSpanFrom(spans, service, path);

    it("reports a request under the trace the gateway started, which the inventory service continues under the agent's span", async () => {
      const received = await get(`${gateway.url}/orders/around-one`);

      const { traceId } = await serverSpan("gateway", "/orders/around-one");
      const gatewayCall = await clientSpanFrom(spans, "gateway", traceId);
      const snapshot = await orders.snapshotFor("/orders/around-one");
      const [call] = wireSpansOf(snapshot.t, "http");
      const inventorySpan = await serverSpan("inventory", "/stock/around-one");

      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
      // The gateway's tracestate is passed on, and with it the last span
      // Datadog knows of - so Datadog, which never sees Observe's span,
      // still hangs the inventory service's under the gateway's call.
      expect(received.headers.tracestate).toContain("dd=");
      expect(inventorySpan.attributes["_dd.parent_id"]).toBe(
        gatewayCall.spanId,
      );
      expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(orders.collector.violations).toEqual([]);
    });

    it("starts a W3C trace from the id it gives a request that arrives in none, and the inventory service continues it", async () => {
      await get(`${orders.url}/orders/around-root`);

      const snapshot = await orders.snapshotFor("/orders/around-root");
      const [call] = wireSpansOf(snapshot.t, "http");
      const inventorySpan = await serverSpan("inventory", "/stock/around-root");

      expect(snapshot.ti[14]).toBe("7");
      expect(inventorySpan.traceId).toBe(w3cTraceIdOf(snapshot.ti));
      expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
    });

    it("starts a trace of its own when the caller sends only Datadog's headers, which it does not read", async () => {
      await get(`${datadogOnlyGateway.url}/orders/around-datadog-only`);

      const gatewaySpan = await serverSpan(
        "datadog-only-gateway",
        "/orders/around-datadog-only",
      );
      const snapshot = await orders.snapshotFor("/orders/around-datadog-only");
      const inventorySpan = await serverSpan(
        "inventory",
        "/stock/around-datadog-only",
      );

      // The gateway's trace ends at its call to the Nest service, and the
      // inventory service continues Observe's instead.
      expect(snapshot.ti[14]).toBe("7");
      expect(inventorySpan.traceId).toBe(w3cTraceIdOf(snapshot.ti));
      expect(inventorySpan.traceId).not.toBe(gatewaySpan.traceId);
    });
  },
);
