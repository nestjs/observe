import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Module,
  OnModuleInit,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientGrpc,
  ClientsModule,
  GrpcMethod,
  NatsContext,
  Transport,
} from "@nestjs/microservices";
import { Metadata } from "@grpc/grpc-js";
import { firstValueFrom, map, Observable } from "rxjs";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata over
 * gRPC: whether `ClientGrpcProxy` runs the dispatch hook, and the processing
 * hooks' context has `getMetadata()`. That context is a plain object built per
 * call, so there is no class to feature-test. The header transports' contexts
 * gained `getMetadata()` in the same release, so `NatsContext` stands in.
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

// Bound at import time, because the client module is configured by a
// decorator that is evaluated then.
const GRPC_URL = `127.0.0.1:${await freePort()}`;

const api = createObserveModule();
const orders = createObserveModule();

interface OrdersService {
  findOne(
    request: { id: string },
    metadata?: Metadata,
  ): Observable<{ id: string; name: string }>;
}

@Controller()
class OrdersGrpcController {
  @GrpcMethod("Orders", "FindOne")
  findOne(data: { id: string }) {
    return { id: data.id, name: `order-${data.id}` };
  }
}

@Module({
  imports: [orders.ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersGrpcController],
})
class OrdersModule {}

@Controller()
class ApiController implements OnModuleInit {
  private orders!: OrdersService;

  constructor(@Inject("ORDERS") private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.orders = this.client.getService<OrdersService>("Orders");
  }

  @Get("order")
  order() {
    return firstValueFrom(this.orders.findOne({ id: "7" }));
  }

  @Get("order-own-id")
  orderWithOwnId() {
    const metadata = new Metadata();
    metadata.set("x-request-id", "caller-chose-this");
    return firstValueFrom(this.orders.findOne({ id: "8" }, metadata));
  }
}

/** A client with a channel of its own, nothing else connects. */
@Controller()
class IdleChannelController implements OnModuleInit {
  orders!: OrdersService;

  constructor(@Inject("ORDERS_IDLE") private readonly client: ClientGrpc) {}

  onModuleInit() {
    this.orders = this.client.getService<OrdersService>("Orders");
  }
}

@Module({
  imports: [
    api.ObserveModule.forRoot(testObserveOptions()),
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
      {
        name: "ORDERS_IDLE",
        transport: Transport.GRPC,
        options: {
          package: "orderstest",
          protoPath: PROTO_PATH,
          url: GRPC_URL,
          // Not the process-wide pool, where the other client's connection
          // would be found ready.
          channelOptions: { "grpc.use_local_subchannel_pool": 1 },
        },
      },
    ]),
  ],
  controllers: [ApiController, IdleChannelController],
})
class ApiModule {}

/**
 * The gRPC counterpart of the TCP and Redis suites: an HTTP request that calls
 * a gRPC service through an injected `ClientGrpc`. The client is a provider,
 * so the agent registers its dispatch hook on it, and the id it attaches
 * travels as call metadata - on framework releases that carry it.
 */
describe("ObserveModule: a trace from HTTP into a gRPC service", () => {
  let apiApp: INestApplication;
  let ordersApp: INestMicroservice;
  let apiSnapshots: CollectedSnapshots;
  let ordersSnapshots: CollectedSnapshots;

  beforeAll(async () => {
    ordersApp = await NestFactory.createMicroservice(OrdersModule, {
      transport: Transport.GRPC,
      options: { package: "orderstest", protoPath: PROTO_PATH, url: GRPC_URL },
      instrument: orders.ObserveInstrument,
      logger: false,
    } as never);
    ordersSnapshots = collectSnapshots(ordersApp);
    await ordersApp.listen();

    apiApp = await NestFactory.create(ApiModule, {
      instrument: api.ObserveInstrument,
      logger: false,
    });
    apiSnapshots = collectSnapshots(apiApp);
    await apiApp.init();
  });

  afterAll(async () => {
    await apiApp?.close();
    await ordersApp?.close();
  });

  beforeEach(() => {
    apiSnapshots.clear();
    ordersSnapshots.clear();
  });

  it("delivers each reply in the context of the call that asked for it, while the channel connects", async () => {
    // grpc-js parks the calls made before its channel is ready, then starts
    // all of them from the callback that continues the first one's
    // connection attempt: every reply came back in the first caller's
    // context, and what the others chained onto it ran under its trace id.
    const als =
      apiApp.get<AsyncLocalStorage<Map<string, unknown>>>(AsyncLocalStorage);
    const { orders: idle } = apiApp.get(IdleChannelController);

    const seen = await Promise.all(
      ["first", "second", "third"].map((caller) =>
        als.run(new Map([["caller", caller]]), () =>
          firstValueFrom(
            idle
              .findOne({ id: caller })
              .pipe(map(() => als.getStore()?.get("caller"))),
          ),
        ),
      ),
    );

    expect(seen).toEqual(["first", "second", "third"]);
  });

  const isFindOne = (item: { operationId?: unknown }) =>
    /FindOne/i.test(String(item.operationId));

  it("completes the call through an instrumented gRPC client, and both sides report", async () => {
    const response = await request(apiApp.getHttpServer())
      .get("/order")
      .expect(200);

    expect(response.body).toEqual({ id: "7", name: "order-7" });
    const http = await waitForSnapshot(
      apiSnapshots,
      (item) => item.operationId === "/order",
    );
    const rpc = await waitForSnapshot(ordersSnapshots, isFindOne);
    expect(http.error).toBeUndefined();
    expect(rpc.protocol).toBe("GRPC");
    expect(rpc.error).toBeUndefined();
  });

  it.runIf(frameworkCarriesMetadata)(
    "runs the handler under the caller's trace id, where the framework carries packet metadata",
    async () => {
      await request(apiApp.getHttpServer())
        .get("/order")
        .set("x-request-id", "grpc-hop-trace-1")
        .expect(200);

      const rpc = await waitForSnapshot(ordersSnapshots, isFindOne);
      expect(rpc.traceId).toBe("grpc-hop-trace-1");
    },
  );

  it.runIf(frameworkCarriesMetadata)(
    "keeps an x-request-id the caller put in the call's metadata itself",
    async () => {
      await request(apiApp.getHttpServer())
        .get("/order-own-id")
        .set("x-request-id", "grpc-hop-trace-2")
        .expect(200);

      const rpc = await waitForSnapshot(ordersSnapshots, isFindOne);
      expect(rpc.traceId).toBe("caller-chose-this");
    },
  );

  it.runIf(!frameworkCarriesMetadata)(
    "mints the handler an id of its own where the framework has no gRPC packet metadata",
    async () => {
      await request(apiApp.getHttpServer())
        .get("/order")
        .set("x-request-id", "grpc-hop-trace-3")
        .expect(200);

      const rpc = await waitForSnapshot(ordersSnapshots, isFindOne);
      expect(rpc.traceId).toMatch(UUID);
      expect(rpc.traceId).not.toBe("grpc-hop-trace-3");
    },
  );
});
