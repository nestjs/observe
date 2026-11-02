import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import {
  Args,
  Field,
  GraphQLModule,
  Int,
  ObjectType,
  Query,
  Resolver,
} from "@nestjs/graphql";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback } from "../testing/observe-harness.js";
import {
  asUuid,
  countHeader,
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
import {
  readTraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";

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

@ObjectType()
class Stock {
  @Field()
  traceparent: string;

  @Field(() => Int)
  traceparents: number;

  @Field()
  requestId: string;
}

@Resolver(() => Stock)
class StockResolver {
  constructor(private readonly inventory: InventoryClient) {}

  @Query(() => Stock)
  async stock(@Args("id") id: string): Promise<Stock> {
    const { headers, rawHeaders } = await this.inventory.stock(id);
    return {
      traceparent: headers.traceparent,
      traceparents: countHeader(rawHeaders, "traceparent"),
      requestId: headers["x-request-id"],
    };
  }
}

/** The module options every service under test runs with, as deployed. */
const reporting = (collector: FakeCollector) => ({
  appKey: "e2e-key",
  appSecret: "e2e-secret",
  serviceId: "orders",
  endpoint: collector.url,
  // The agent's floor, so the first batch goes within a second.
  flushInterval: 1000,
  runtimeMetrics: false,
  forwardLogs: false,
  openTelemetry: true,
});

let otlp: OtlpReceiver;
let inventory: OpenTelemetryService;

// One backend and one service at the end of the line for every suite here;
// each suite puts its own Nest service and gateway in front.
beforeAll(async () => {
  otlp = await startOtlpReceiver();
  inventory = await startOpenTelemetryService({ name: "inventory", otlp });
  inventoryUrl = inventory.url;
}, 30_000);

afterAll(async () => {
  await inventory?.stop();
  await otlp?.close();
});

/** A service's server span for a request to `path`. */
const serverSpan = (service: string, path: string) =>
  serverSpanFrom(() => otlp.spans, service, path);

/**
 * What a team means by "we already have OpenTelemetry, and only one of our
 * services is NestJS": the services around the Nest one run the
 * OpenTelemetry SDK - here a gateway and an inventory service, instrumented
 * the zero-code way in processes of their own - and the Nest service runs
 * the agent with `openTelemetry` on, and no SDK.
 *
 *   client → gateway (OpenTelemetry) → orders (Nest + Observe) → inventory (OpenTelemetry)
 *
 * End to end: the agent's own worker sends to a collector, which has to take
 * a batch before interop starts, and each tool's part of a request is read
 * back from where it landed - the batch for Observe, the OTLP receiver for
 * OpenTelemetry. One request is one trace in both.
 */
describe.each([
  ["Express", () => undefined],
  ["Fastify", () => new FastifyAdapter()],
])(
  "OpenTelemetry in the services around a Nest service on %s, none in it",
  (platform, adapter) => {
    // The receiver and the inventory service are shared with the other
    // suites in this file, so every path names the platform too.
    const id = (name: string) => `${platform.toLowerCase()}-${name}`;
    let collector: FakeCollector;
    let app: INestApplication;
    let ordersUrl = "";
    let gateway: OpenTelemetryService;

    beforeAll(async () => {
      collector = await startFakeCollector();
      const { ObserveModule, ObserveInstrument } = createObserveModule();

      @Module({
        imports: [ObserveModule.forRoot(reporting(collector))],
        controllers: [OrdersController],
        providers: [InventoryClient],
      })
      class OrdersModule {}

      const httpAdapter = adapter();
      const options = { instrument: ObserveInstrument, logger: false } as const;
      app = httpAdapter
        ? await NestFactory.create(OrdersModule, httpAdapter, options)
        : await NestFactory.create(OrdersModule, options);
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
      await collector?.close();
    });

    /** A request through the gateway; what reached the inventory service. */
    const viaGateway = async (
      path: string,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(`${gateway.url}${path}`, { headers });
      expect(response.status).toBe(200);
      return (await response.json()) as ReceivedRequest;
    };

    const snapshotFor = (path: string) =>
      snapshotAt(
        collector,
        (snapshot) => snapshot.a?.ou === path,
        `the snapshot for ${path} at the collector`,
      );

    it("reports a request under the trace the gateway started, which the inventory service continues under the agent's span", async () => {
      const received = await viaGateway(`/orders/${id("one")}`);

      const { traceId } = await serverSpan("gateway", `/orders/${id("one")}`);
      const snapshot = await snapshotFor(`/orders/${id("one")}`);
      const [call] = wireSpansOf(snapshot.t, "http");
      const inventorySpan = await serverSpan(
        "inventory",
        `/stock/${id("one")}`,
      );

      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(inventorySpan.traceId).toBe(traceId);
      // The agent's span for the call is the parent the inventory service
      // saw, so its spans nest under the call in the trace.
      expect(call).toBeDefined();
      expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
      expect(countHeader(received.rawHeaders, "traceparent")).toBe(1);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });

    it("starts a W3C trace from the id it gives a request that arrives in none, and the inventory service continues it", async () => {
      const response = await fetch(`${ordersUrl}/orders/${id("two")}`);
      const received = (await response.json()) as ReceivedRequest;

      const snapshot = await snapshotFor(`/orders/${id("two")}`);
      const [call] = wireSpansOf(snapshot.t, "http");
      const inventorySpan = await serverSpan(
        "inventory",
        `/stock/${id("two")}`,
      );

      // A UUIDv7 of its own, as with the option off.
      expect(snapshot.ti[14]).toBe("7");
      expect(inventorySpan.traceId).toBe(w3cTraceIdOf(snapshot.ti));
      expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
      expect(received.headers["x-request-id"]).toBe(snapshot.ti);
    });

    it("keeps to the gateway's trace when a mesh's x-request-id comes with it", async () => {
      // What Envoy stamps on every request it routes: a UUIDv4 unrelated to
      // any trace, which the gateway passes on as a sidecar would.
      const meshRequestId = randomUUID();
      const received = await viaGateway(`/orders/${id("three")}`, {
        "x-request-id": meshRequestId,
      });

      const { traceId } = await serverSpan("gateway", `/orders/${id("three")}`);
      const snapshot = await snapshotFor(`/orders/${id("three")}`);

      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(readTraceContext(received.headers)?.traceId).toBe(traceId);
    });

    it("records a request its caller sampled out, and passes that decision on", async () => {
      const traceId = randomBytes(16).toString("hex");
      const received = await viaGateway(`/orders/${id("four")}`, {
        traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-00`,
      });

      const snapshot = await snapshotFor(`/orders/${id("four")}`);

      // Observe samples by its own rules, so the request is reported - under
      // the trace OpenTelemetry left out, should it be looked up by its id.
      expect(snapshot.ti).toBe(asUuid(traceId));
      expect(readTraceContext(received.headers)).toMatchObject({
        traceId,
        sampled: false,
      });

      // A request sampled in after it: once both services' spans for that
      // one are in, any span recorded for the first would be too.
      await viaGateway(`/orders/${id("four-after")}`);
      await serverSpan("gateway", `/orders/${id("four-after")}`);
      await serverSpan("inventory", `/stock/${id("four-after")}`);
      expect(otlp.spans.filter((span) => span.traceId === traceId)).toEqual([]);
    });
  },
);

/**
 * The same, with the Nest service a GraphQL server - a federation subgraph
 * behind a router that traces, say. The HTTP agent opens the trace for
 * `POST /graphql` before the GraphQL agent names the operation, so the
 * operation joins the gateway's trace like any request.
 */
describe("OpenTelemetry in the services around a Nest GraphQL service, none in it", () => {
  let collector: FakeCollector;
  let app: INestApplication;
  let gateway: OpenTelemetryService;

  beforeAll(async () => {
    collector = await startFakeCollector();
    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot(reporting(collector)),
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          playground: false,
        }),
      ],
      controllers: [OrdersController],
      providers: [InventoryClient, StockResolver],
    })
    class OrdersGraphqlModule {}

    app = await NestFactory.create(OrdersGraphqlModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    const ordersUrl = await listenOnLoopback(app);
    gateway = await startOpenTelemetryService({
      name: "graphql-gateway",
      otlp,
      next: ordersUrl,
    });
    await untilIngesting(app, ordersUrl);
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    await app?.close();
    await collector?.close();
  });

  it("reports an operation under the gateway's trace, and carries it on to the services the resolver calls", async () => {
    const response = await fetch(`${gateway.url}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          '{ stock(id: "graphql") { traceparent traceparents requestId } }',
      }),
    });
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as {
      data: { stock: Stock };
    };

    const { traceId } = await serverSpan("graphql-gateway", "/graphql");
    const snapshot = await snapshotAt(
      collector,
      (item) => item.op === "Query.stock",
      "the operation's snapshot at the collector",
    );
    const [call] = wireSpansOf(snapshot.t, "http");
    const inventorySpan = await serverSpan("inventory", "/stock/graphql");

    expect(snapshot.ti).toBe(asUuid(traceId));
    expect(data.stock.traceparents).toBe(1);
    expect(data.stock.requestId).toBe(asUuid(traceId));
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(w3cSpanIdOf(String(call.s)));
    expect(collector.violations).toEqual([]);
  });
});
