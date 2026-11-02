// First, before anything that loads http, express or @nestjs/core: dd-trace
// patches only what loads after it starts.
const { agent, untracedFetch } = await vi.hoisted(async () => {
  const { startDatadogTracer } = await import("../testing/datadog-tracer.js");
  return startDatadogTracer();
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
import { readTraceContext } from "../utils/trace-context.util.js";

/**
 * A team on Datadog everywhere, its Nest service included, adding Observe to
 * that service: dd-trace starts first, as `--require dd-trace/init` or a
 * `require("dd-trace").init()` at the top of `main.ts` starts it, with its
 * defaults, and the agent runs beside it with `openTelemetry` on.
 *
 *   client → gateway (dd-trace) → orders (Nest + dd-trace + Observe) → inventory (dd-trace)
 *
 * dd-trace keeps its spans to itself - nothing registers them with the
 * OpenTelemetry API - so the agent cannot follow them, and goes by the
 * headers a request arrived with, as it would with no tracer beside it.
 * `datadog-e2e-tracer-provider` runs the same requests with dd-trace's
 * spans registered there.
 */
describe.skipIf(!datadogRuns)(
  "dd-trace in a Nest service, with its defaults, and in the services around it",
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
      const received = await get(`${gateway.url}/orders/in-one`);

      const { traceId } = await serverSpan("gateway", "/orders/in-one");
      const ordersSpan = await serverSpan("orders", "/orders/in-one");
      const ordersCall = await clientSpanFrom(spans, "orders", traceId);
      const inventorySpan = await serverSpan("inventory", "/stock/in-one");
      const snapshot = await orders.snapshotFor("/orders/in-one");

      expect(snapshot.ti).toBe(asUuid(traceId));
      // Datadog's trace is whole: gateway → orders → inventory.
      expect(ordersSpan.traceId).toBe(traceId);
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(ordersCall.spanId);
      // One traceparent on the call - dd-trace's, written before the agent
      // sees the request - and the agent's x-request-id.
      expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
      expect(readTraceContext(received.headers)?.parentSpanId).toBe(
        ordersCall.spanId,
      );
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(orders.collector.violations).toEqual([]);
    });

    it("names a request that starts at the Nest service by an id of its own, while dd-trace starts another trace for it", async () => {
      const received = await get(`${orders.url}/orders/in-root`);

      const ordersSpan = await serverSpan("orders", "/orders/in-root");
      const inventorySpan = await serverSpan("inventory", "/stock/in-root");
      const snapshot = await orders.snapshotFor("/orders/in-root");

      expect(ordersSpan.parentSpanId).toBeUndefined();
      // Two traces for one request: the agent's own UUIDv7, and the one
      // dd-trace started and carried on in its traceparent.
      expect(snapshot.ti[14]).toBe("7");
      expect(snapshot.ti).not.toBe(asUuid(ordersSpan.traceId));
      expect(inventorySpan.traceId).toBe(ordersSpan.traceId);
      expect(readTraceContext(received.headers)?.traceId).toBe(
        ordersSpan.traceId,
      );
      // So the call carries two ids that disagree, and a service further on
      // that runs Observe goes by the traceparent: it lands in dd-trace's
      // trace, not in this one.
      expect(received.headers["x-request-id"]).toBe(snapshot.ti);
    });

    it("starts a trace of its own when the caller sends only Datadog's headers, which dd-trace continues", async () => {
      await get(`${datadogOnlyGateway.url}/orders/in-datadog-only`);

      const { traceId } = await serverSpan(
        "datadog-only-gateway",
        "/orders/in-datadog-only",
      );
      const ordersSpan = await serverSpan("orders", "/orders/in-datadog-only");
      const snapshot = await orders.snapshotFor("/orders/in-datadog-only");

      expect(ordersSpan.traceId).toBe(traceId);
      expect(snapshot.ti[14]).toBe("7");
      expect(snapshot.ti).not.toBe(asUuid(traceId));
    });
  },
);
