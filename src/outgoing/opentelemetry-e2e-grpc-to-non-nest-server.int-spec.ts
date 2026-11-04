import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import {
  Controller,
  Get,
  Inject,
  INestApplication,
  Module,
  OnModuleInit,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientGrpc,
  ClientsModule,
  NatsContext,
  Transport,
} from "@nestjs/microservices";
import { join } from "node:path";
import { firstValueFrom, Observable } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback } from "../testing/observe-harness.js";
import {
  snapshotAt,
  untilIngesting,
  wireSpansOf,
} from "../testing/opentelemetry-e2e.js";
import {
  readTraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata over
 * gRPC (12.3.3 and later) - see the gRPC trace propagation suite, which also
 * covers a call made without it.
 */
const frameworkCarriesMetadata =
  typeof (NatsContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

/** A version-00 `traceparent`, as the spec writes one. */
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

/** Every metadata entry a call arrived with: each key's values, in order. */
type ReceivedMetadata = Record<string, Array<string | Buffer>>;

interface PlainGrpcServer {
  /** `host:port`, on 127.0.0.1. */
  readonly url: string;
  /** The metadata each `FindOne` call arrived with, by order id. */
  readonly received: Map<string, ReceivedMetadata>;
  close(): Promise<void>;
}

/**
 * A gRPC server built on `@grpc/grpc-js` alone - no Nest, no Observe -
 * standing in for a service in another language: whatever it reads off a
 * call's metadata is what a Go, Java or Python service's OpenTelemetry gRPC
 * instrumentation reads there. It records each call's metadata and answers.
 */
async function startPlainGrpcServer(): Promise<PlainGrpcServer> {
  const definition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    defaults: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    orderstest: { Orders: { service: grpc.ServiceDefinition } };
  };
  const received = new Map<string, ReceivedMetadata>();
  const server = new grpc.Server();
  server.addService(loaded.orderstest.Orders.service, {
    FindOne: (
      call: grpc.ServerUnaryCall<{ id: string }, unknown>,
      callback: grpc.sendUnaryData<{ id: string; name: string }>,
    ) => {
      received.set(call.request.id, call.metadata.toJSON());
      callback(null, { id: call.request.id, name: `order-${call.request.id}` });
    },
  });
  // A port the OS picks on 127.0.0.1 itself, which nothing else can hold.
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (error, bound) => (error ? reject(error) : resolve(bound)),
    ),
  );
  return {
    url: `127.0.0.1:${port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => server.tryShutdown(() => resolve())),
  };
}

interface OrdersService {
  findOne(
    request: { id: string },
    metadata?: grpc.Metadata,
  ): Observable<{ id: string; name: string }>;
}

@Controller()
class OrdersController implements OnModuleInit {
  private orders!: OrdersService;

  constructor(@Inject("ORDERS") private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.orders = this.client.getService<OrdersService>("Orders");
  }

  @Get("health")
  health() {
    return "ok";
  }

  @Get("orders/:id")
  order(@Param("id") id: string) {
    return firstValueFrom(this.orders.findOne({ id }));
  }

  /** A call whose metadata names an id of the application's choosing. */
  @Get("orders/:id/own-request-id")
  orderWithOwnRequestId(@Param("id") id: string) {
    const metadata = new grpc.Metadata();
    metadata.set("x-request-id", `chosen-${id}`);
    return firstValueFrom(this.orders.findOne({ id }, metadata));
  }
}

/**
 * A Nest service with Observe and no OpenTelemetry SDK, calling a gRPC
 * service that runs neither, through a `ClientGrpc` registered with
 * `ClientsModule`. The client is a provider, so the agent sets its dispatch
 * hook on it, and `@nestjs/microservices` 12.3.3 runs that hook for every
 * gRPC call and puts what it attaches in the call's metadata
 * (nestjs/nest#18386). With `openTelemetry` on that is a W3C `traceparent`
 * as well as `x-request-id`, which is all an OpenTelemetry-instrumented
 * service in another language needs to continue the trace.
 *
 *   client → api (Nest + Observe) → gRPC → orders (plain @grpc/grpc-js)
 *
 * End to end: the agent's real worker sends to a fake collector, so the
 * trace id compared is the one Observe reports the request under, and
 * interop runs as it does in a deployed service - once a first batch got in.
 */
describe.runIf(frameworkCarriesMetadata)(
  "OpenTelemetry interop on a gRPC call to a service that runs neither Nest nor Observe",
  () => {
    let grpcServer: PlainGrpcServer;
    let collector: FakeCollector;

    beforeAll(async () => {
      grpcServer = await startPlainGrpcServer();
      collector = await startFakeCollector();
    });

    afterAll(async () => {
      await collector?.close();
      await grpcServer?.close();
    });

    /** Starts the Nest service, and waits for its first batch to get in. */
    const startApi = async (openTelemetry: boolean) => {
      const { ObserveModule, ObserveInstrument } = createObserveModule();

      @Module({
        imports: [
          ObserveModule.forRoot({
            appKey: "e2e-key",
            appSecret: "e2e-secret",
            serviceId: `api-${openTelemetry ? "on" : "off"}`,
            endpoint: collector.url,
            flushInterval: 1000,
            runtimeMetrics: false,
            forwardLogs: false,
            openTelemetry,
          }),
          ClientsModule.register([
            {
              name: "ORDERS",
              transport: Transport.GRPC,
              options: {
                package: "orderstest",
                protoPath: PROTO_PATH,
                url: grpcServer.url,
              },
            },
          ]),
        ],
        controllers: [OrdersController],
      })
      class ApiModule {}

      const app = await NestFactory.create(ApiModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      const url = await listenOnLoopback(app);
      await untilIngesting(app, url);
      return { app, url };
    };

    /**
     * Makes the request, and returns the metadata the gRPC call arrived with
     * and the snapshot Observe reported the request in.
     */
    const call = async (url: string, path: string, orderId: string) => {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: orderId,
        name: `order-${orderId}`,
      });
      const snapshot = await snapshotAt(
        collector,
        (candidate) => candidate.a?.ou === path,
        `the snapshot for ${path} at the collector`,
      );
      return { metadata: grpcServer.received.get(orderId)!, snapshot };
    };

    describe("with openTelemetry on", () => {
      let app: INestApplication;
      let url = "";

      beforeAll(async () => {
        ({ app, url } = await startApi(true));
      }, 60_000);

      afterAll(async () => {
        await app?.close();
      });

      it("sends a traceparent in the trace Observe reports the request under, and x-request-id beside it", async () => {
        const { metadata, snapshot } = await call(url, "/orders/on-1", "on-1");

        // One traceparent, which the spec accepts...
        expect(metadata["traceparent"]).toHaveLength(1);
        const [traceparent] = metadata["traceparent"];
        expect(traceparent).toMatch(TRACEPARENT);
        const traceContext = readTraceContext({ traceparent });
        expect(traceContext).toBeDefined();
        // ...naming the trace Observe reports the request under, in its W3C
        // form, and as the parent the agent's span for the handler that made
        // the call - sampled, as the agent records the request.
        expect(traceContext!.traceId).toBe(w3cTraceIdOf(snapshot.ti));
        const [handler] = wireSpansOf(snapshot.t, "OrdersController");
        expect(handler?.m).toBe("order");
        expect(traceContext!.parentSpanId).toBe(w3cSpanIdOf(String(handler.s)));
        expect(traceContext!.sampled).toBe(true);
        // And Observe's own id for the trace beside it, as it is.
        expect(metadata["x-request-id"]).toEqual([snapshot.ti]);
        expect(collector.violations).toEqual([]);
      });

      // Pins current behaviour. The dispatch hook adds `traceparent` only
      // beside the `x-request-id` it adds itself, so as not to send one beside
      // an id the application chose - but gRPC runs it on a packet of its own,
      // before the caller's `Metadata` is merged in, and the caller's id wins
      // that merge. So the call carries the caller's id and a `traceparent`
      // for the request's trace: a service that reads `traceparent` continues
      // the request's trace, one that reads `x-request-id` the caller's.
      it("sends a traceparent for the request's trace beside an x-request-id the caller put in the call's metadata itself", async () => {
        const { metadata, snapshot } = await call(
          url,
          "/orders/on-2/own-request-id",
          "on-2",
        );

        expect(metadata["x-request-id"]).toEqual(["chosen-on-2"]);
        expect(metadata["traceparent"]).toHaveLength(1);
        const traceContext = readTraceContext({
          traceparent: metadata["traceparent"][0],
        });
        expect(traceContext?.traceId).toBe(w3cTraceIdOf(snapshot.ti));
        expect(traceContext?.traceId).not.toBe(w3cTraceIdOf("chosen-on-2"));
      });
    });

    describe("with openTelemetry off", () => {
      let app: INestApplication;
      let url = "";

      beforeAll(async () => {
        ({ app, url } = await startApi(false));
      }, 60_000);

      afterAll(async () => {
        await app?.close();
      });

      it("sends x-request-id alone", async () => {
        const { metadata, snapshot } = await call(
          url,
          "/orders/off-1",
          "off-1",
        );

        expect(metadata["traceparent"]).toBeUndefined();
        expect(metadata["x-request-id"]).toEqual([snapshot.ti]);
        expect(collector.violations).toEqual([]);
      });
    });
  },
);
