// First, before anything that loads http, express, @nestjs/core or
// @grpc/grpc-js: the SDK's instrumentations patch only what loads after it
// starts. Nest loads grpc-js with `require` as a client or server is made, so
// OpenTelemetry's gRPC instrumentation patches it then.
import {
  openTelemetrySpans,
  shutdownOpenTelemetry,
} from "../testing/opentelemetry-sdk.js";
import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Injectable,
  Module,
  OnModuleInit,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientGrpc,
  ClientsModule,
  GrpcMethod,
  NatsContext,
  Transport,
} from "@nestjs/microservices";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
// A type alone: imported here, grpc-js would load before Nest requires it,
// and the instrumentation would not patch it.
import type { Metadata } from "@grpc/grpc-js";
import { join } from "node:path";
import { firstValueFrom, Observable } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { freePort, listenOnLoopback } from "../testing/observe-harness.js";
import {
  asUuid,
  exportedSpanOf,
  pathOf,
  ReceivedRequest,
  serverSpanFrom,
  snapshotAt,
  spanFrom,
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

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata over
 * gRPC (12.3.3 and later) - see the gRPC trace propagation suite.
 */
const frameworkCarriesMetadata =
  typeof (NatsContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);
// Bound at import time: the client module is configured by a decorator.
const GRPC_URL = `127.0.0.1:${await freePort()}`;
/** OpenTelemetry's name for the call, on both sides of it. */
const RPC_SPAN_NAME = "grpc.orderstest.Orders/FindOne";

let inventoryUrl = "";

/** What each handler was called with and its call received, by order id. */
const runs = new Map<
  string,
  { traceparents: unknown[]; received: ReceivedRequest }
>();

@Injectable()
class InventoryClient {
  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

@Controller()
class OrdersGrpcController {
  constructor(private readonly inventory: InventoryClient) {}

  @GrpcMethod("Orders", "FindOne")
  async findOne(data: { id: string }, metadata: Metadata) {
    runs.set(data.id, {
      traceparents: metadata.get("traceparent"),
      received: await this.inventory.stock(data.id),
    });
    return { id: data.id, name: `order-${data.id}` };
  }
}

interface OrdersService {
  findOne(request: { id: string }): Observable<{ id: string; name: string }>;
}

@Controller()
class ApiController implements OnModuleInit {
  private orders!: OrdersService;

  constructor(@Inject("ORDERS") private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.orders = this.client.getService<OrdersService>("Orders");
  }

  @Get("orders/:id")
  order(@Param("id") id: string) {
    return firstValueFrom(this.orders.findOne({ id }));
  }
}

/**
 * Two Nest services that run the OpenTelemetry Node SDK, its gRPC
 * instrumentation included, as well as Observe, with `openTelemetry` on: an
 * HTTP request calls a gRPC handler, which calls a service that exports to
 * an OpenTelemetry backend.
 *
 *   client → api (Nest + OpenTelemetry + Observe) → gRPC → orders (Nest + OpenTelemetry + Observe) → inventory (OpenTelemetry)
 *
 * From `@nestjs/microservices` 12.3.3 the agent puts a `traceparent` in the
 * call's metadata, beside `x-request-id`, for a server in another language
 * to continue. The gRPC instrumentation writes its own over it - its client
 * span's - so the call carries one, and the server side continues it with a
 * server span of its own, running the handler in it. The agent hands no
 * trace to the SDK for a gRPC handler, so the handler's spans stay under
 * that server span.
 */
describe.runIf(frameworkCarriesMetadata)(
  "OpenTelemetry's gRPC instrumentation in two Nest services",
  () => {
    const api = createObserveModule();
    const orders = createObserveModule();
    let otlp: OtlpReceiver;
    let inventory: OpenTelemetryService;
    let collector: FakeCollector;
    let apiApp: INestApplication;
    let ordersApp: INestMicroservice;
    let apiUrl = "";

    beforeAll(async () => {
      otlp = await startOtlpReceiver();
      inventory = await startOpenTelemetryService({ name: "inventory", otlp });
      inventoryUrl = inventory.url;
      collector = await startFakeCollector();

      const observeOptions = (serviceId: string) => ({
        appKey: "e2e-key",
        appSecret: "e2e-secret",
        serviceId,
        endpoint: collector.url,
        flushInterval: 1000,
        runtimeMetrics: false,
        forwardLogs: false,
        openTelemetry: true,
      });

      @Module({
        imports: [orders.ObserveModule.forRoot(observeOptions("orders"))],
        controllers: [OrdersGrpcController],
        providers: [InventoryClient],
      })
      class OrdersModule {}

      @Module({
        imports: [
          api.ObserveModule.forRoot(observeOptions("api")),
          ClientsModule.register([
            {
              name: "ORDERS",
              transport: Transport.GRPC,
              options: {
                package: "orderstest",
                protoPath: PROTO_PATH,
                url: GRPC_URL,
              },
            },
          ]),
        ],
        controllers: [ApiController],
      })
      class ApiModule {}

      ordersApp = await NestFactory.createMicroservice(OrdersModule, {
        transport: Transport.GRPC,
        options: {
          package: "orderstest",
          protoPath: PROTO_PATH,
          url: GRPC_URL,
        },
        instrument: orders.ObserveInstrument,
        logger: false,
      } as never);
      await ordersApp.listen();
      apiApp = await NestFactory.create(ApiModule, {
        instrument: api.ObserveInstrument,
        logger: false,
      });
      apiUrl = await listenOnLoopback(apiApp);
    }, 60_000);

    afterAll(async () => {
      await apiApp?.close();
      await ordersApp?.close();
      await inventory?.stop();
      await collector?.close();
      await otlp?.close();
      await shutdownOpenTelemetry();
    });

    /** Every span the SDK in this process kept - both Nest services'. */
    const nestSpans = (): ExportedSpan[] =>
      openTelemetrySpans
        .getFinishedSpans()
        .map((span) => exportedSpanOf(span, "orders"));

    it("carries one traceparent and runs the handler under the instrumentation's server span, in the request's trace in both tools", async () => {
      // From outside any trace: the SDK instruments this process's own
      // `fetch` too.
      const response = await context.with(
        suppressTracing(context.active()),
        () => fetch(`${apiUrl}/orders/7`),
      );
      expect(response.status).toBe(200);

      const { traceId } = await serverSpanFrom(
        nestSpans,
        "orders",
        "/orders/7",
      );
      const rpc = (kind: ExportedSpan["kind"]) =>
        spanFrom(
          nestSpans,
          (span) =>
            span.kind === kind &&
            span.name === RPC_SPAN_NAME &&
            span.traceId === traceId,
          `the gRPC instrumentation's ${kind} span`,
        );
      const rpcClient = await rpc("client");
      const rpcServer = await rpc("server");
      const call = await spanFrom(
        nestSpans,
        (span) => span.kind === "client" && pathOf(span) === "/stock/7",
        "the SDK's span for the handler's call",
      );
      const inventorySpan = await serverSpanFrom(
        () => otlp.spans,
        "inventory",
        "/stock/7",
      );

      // One traceparent on the call, the instrumentation's client span's...
      const run = runs.get("7")!;
      expect(run.traceparents).toHaveLength(1);
      expect(
        readTraceContext({ traceparent: String(run.traceparents[0]) })
          ?.parentSpanId,
      ).toBe(rpcClient.spanId);
      // ...which the server span continues...
      expect(rpcServer.parentSpanId).toBe(rpcClient.spanId);
      // ...and the handler's call under the server span, not beside it.
      expect(call.traceId).toBe(traceId);
      expect(call.parentSpanId).toBe(rpcServer.spanId);
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(call.spanId);
      expect(readTraceContext(run.received.headers)?.traceId).toBe(traceId);
      expect(run.received.headers["x-request-id"]).toBe(asUuid(traceId));

      // And Observe reports the handler under the request's trace id.
      const handled = await snapshotAt(
        collector,
        (snapshot) => snapshot.p === "GRPC",
        "the orders service's snapshot for the call",
      );
      expect(handled.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  },
);
