import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Module,
  OnModuleInit,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientGrpc,
  ClientProxy,
  ClientsModule,
  GrpcMethod,
  MessagePattern,
  NatsContext,
  Payload,
  Transport,
} from "@nestjs/microservices";
import type { Job, Queue } from "bullmq";
import { connect } from "node:net";
import { join } from "node:path";
import { firstValueFrom, Observable } from "rxjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  FakeOtlpReceiver,
  ReceivedOtlpSpan,
  startFakeOtlpReceiver,
} from "../testing/fake-otlp-receiver.js";
import {
  freePort,
  listenOnLoopback,
  testObserveOptions,
} from "../testing/observe-harness.js";
import { untilIngesting } from "../testing/opentelemetry-e2e.js";
import { SpanKind } from "./otlp-span.mapper.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** BullMQ has no in-memory driver, so the job suite runs only where Redis answers. */
const redisReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: REDIS_HOST, port: REDIS_PORT });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata
 * (12.0.4 and later), which is how a TCP message carries the trace at all.
 */
const frameworkCarriesMetadata =
  typeof (ClientProxy.prototype as { setOnDispatchHook?: unknown })
    .setOnDispatchHook === "function";

/**
 * Whether it carries packet metadata over gRPC as well (12.3.3 and later):
 * the header transports' contexts gained `getMetadata()` in the same
 * release, so `NatsContext` stands in - see the gRPC propagation suite.
 */
const frameworkCarriesGrpcMetadata =
  typeof (NatsContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

const QUEUE_NAME = `observe-otlp-jobs-${process.pid}`;
// Bound at import time: the client modules are configured by decorators.
const TCP_PORT = await freePort();
const GRPC_URL = `127.0.0.1:${await freePort()}`;
const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);

/** What every app here reports with: export granted in full, to one receiver. */
const reporting = (
  collector: FakeCollector,
  receiver: FakeOtlpReceiver,
  serviceId: string,
): ObserveOptions =>
  testObserveOptions({
    serviceId,
    endpoint: collector.url,
    flushInterval: 1000,
    openTelemetry: true,
    otlp: {
      endpoint: receiver.url,
      protocol: "http/json",
      serviceName: serviceId,
    },
  });

/** The exported span a span's parent id names, in the same trace. */
const parentOf = (receiver: FakeOtlpReceiver, span: ReceivedOtlpSpan) =>
  receiver
    .spans()
    .find(
      (candidate) =>
        candidate.traceId === span.traceId &&
        candidate.spanId === span.parentSpanId,
    );

/** The names from a span up to its trace's root, for a readable assertion. */
const ancestryOf = (receiver: FakeOtlpReceiver, span: ReceivedOtlpSpan) => {
  const names: string[] = [];
  for (
    let at: ReceivedOtlpSpan | undefined = span;
    at;
    at = at.parentSpanId === undefined ? undefined : parentOf(receiver, at)
  ) {
    names.push(at.name);
  }
  return names;
};

/**
 * `otlp` for the work a request hands on: with `openTelemetry` on, a queue
 * job and a microservice message carry the request's W3C trace context, and
 * the span exported for the job's run or the message's handler goes under
 * the span that handed the work on - so in an OpenTelemetry backend the
 * request's tree reaches down into them, instead of their being further
 * roots of the same trace.
 */
describe("ObserveModule: OTLP export of the work a request hands on", () => {
  let collector: FakeCollector;
  let receiver: FakeOtlpReceiver;

  beforeAll(async () => {
    collector = await startFakeCollector();
    collector.answerWith({ degraded: false, otlpExport: "full" });
    receiver = await startFakeOtlpReceiver();
  });

  afterAll(async () => {
    await receiver?.close();
    await collector?.close();
  });

  describe.skipIf(!redisReachable)("a queue job", () => {
    @Processor(QUEUE_NAME)
    class ConfirmationProcessor extends WorkerHost {
      process(job: Job<{ id: string }>) {
        return Promise.resolve({ confirmed: job.data.id });
      }
    }

    @Controller()
    class OrdersController {
      constructor(@InjectQueue(QUEUE_NAME) private readonly queue: Queue) {}

      @Get("health")
      health() {
        return "ok";
      }

      @Get("orders/:id/confirm")
      async confirm(@Param("id") id: string) {
        await this.queue.add("confirm-order", { id });
        return { queued: id };
      }
    }

    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      const { ObserveModule, ObserveInstrument } = createObserveModule();

      @Module({
        imports: [
          BullModule.forRoot({
            connection: { host: REDIS_HOST, port: REDIS_PORT },
          }),
          BullModule.registerQueue({ name: QUEUE_NAME }),
          ObserveModule.forRoot(reporting(collector, receiver, "orders")),
        ],
        controllers: [OrdersController],
        providers: [ConfirmationProcessor],
      })
      class OrdersModule {}

      app = await NestFactory.create(OrdersModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      url = await listenOnLoopback(app);
      await untilIngesting(app, url);
    }, 30_000);

    afterAll(async () => {
      await app
        ?.get<Queue>(`BullQueue_${QUEUE_NAME}`)
        .obliterate({ force: true })
        .catch(() => undefined);
      await app?.close();
    });

    it("puts the job's span under the span that enqueued it, in the request's tree", async () => {
      const response = await fetch(`${url}/orders/job-1/confirm`);
      expect(response.status).toBe(200);

      const front = await receiver.waitForSpan(
        (span) => span.attributes["url.path"] === "/orders/job-1/confirm",
      );
      const run = await receiver.waitForSpan(
        (span) =>
          span.traceId === front.traceId && span.kind === SpanKind.CONSUMER,
      );

      // Up through the span that called `Queue.add` and the handler that
      // made the call, to the request's own span at the root.
      const ancestry = ancestryOf(receiver, run);
      expect(ancestry[0]).toBe(`${QUEUE_NAME} confirm-order`);
      expect(ancestry).toContain("OrdersController.confirm");
      expect(ancestry.at(-1)).toBe("GET /orders/:id/confirm");
      expect(front.parentSpanId).toBeUndefined();
      // Sampled, with a parent in another process's export.
      expect(run.flags).toBe(0x301);
    });
  });

  describe.runIf(frameworkCarriesMetadata)("a TCP message", () => {
    @Controller()
    class StockController {
      @MessagePattern("ping")
      ping() {
        return "pong";
      }

      @MessagePattern("reserve")
      reserve(@Payload() id: string) {
        return { reserved: id };
      }
    }

    @Controller()
    class ReservingController {
      constructor(@Inject("STOCK") private readonly stock: ClientProxy) {}

      /** Reaches the stock service too, so a warm-up gets both their batches in. */
      @Get("health")
      health() {
        return firstValueFrom(this.stock.send<string>("ping", {}));
      }

      @Get("orders/:id/reserve")
      reserve(@Param("id") id: string) {
        return firstValueFrom(this.stock.send("reserve", id));
      }
    }

    let apiApp: INestApplication;
    let stockApp: INestMicroservice;
    let apiUrl = "";

    beforeAll(async () => {
      const api = createObserveModule();
      const stock = createObserveModule();

      @Module({
        imports: [
          stock.ObserveModule.forRoot(reporting(collector, receiver, "stock")),
        ],
        controllers: [StockController],
      })
      class StockModule {}

      @Module({
        imports: [
          api.ObserveModule.forRoot(reporting(collector, receiver, "api")),
          ClientsModule.register([
            {
              name: "STOCK",
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: TCP_PORT },
            },
          ]),
        ],
        controllers: [ReservingController],
      })
      class ApiModule {}

      stockApp = await NestFactory.createMicroservice(StockModule, {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: TCP_PORT },
        instrument: stock.ObserveInstrument,
        logger: false,
      } as never);
      await stockApp.listen();
      apiApp = await NestFactory.create(ApiModule, {
        instrument: api.ObserveInstrument,
        logger: false,
      });
      apiUrl = await listenOnLoopback(apiApp);
      await untilIngesting(apiApp, apiUrl, 15_000, [stockApp]);
    }, 30_000);

    afterAll(async () => {
      await apiApp?.close();
      await stockApp?.close();
    });

    it("puts the handler's span under the span that sent the message, in the request's tree", async () => {
      const response = await fetch(`${apiUrl}/orders/tcp-1/reserve`);
      expect(response.status).toBe(200);

      const front = await receiver.waitForSpan(
        (span) => span.attributes["url.path"] === "/orders/tcp-1/reserve",
      );
      const handler = await receiver.waitForSpan(
        (span) =>
          span.traceId === front.traceId &&
          span.kind === SpanKind.SERVER &&
          span.name === "reserve",
      );

      // Up through the span that sent the message - one of the client's, as
      // the agent records it - and the handler that sent it, to the
      // request's own span at the root.
      const ancestry = ancestryOf(receiver, handler);
      expect(ancestry).toContain("ReservingController.reserve");
      expect(ancestry.at(-1)).toBe("GET /orders/:id/reserve");
      expect(handler.flags).toBe(0x301);
    });
  });

  describe.runIf(frameworkCarriesGrpcMetadata)("a gRPC call", () => {
    interface OrdersService {
      findOne(request: {
        id: string;
      }): Observable<{ id: string; name: string }>;
    }

    @Controller()
    class OrdersGrpcController {
      @GrpcMethod("Orders", "FindOne")
      findOne(data: { id: string }) {
        return { id: data.id, name: `order-${data.id}` };
      }
    }

    @Controller()
    class ApiController implements OnModuleInit {
      private orders!: OrdersService;

      constructor(@Inject("ORDERS") private readonly client: ClientGrpc) {}

      onModuleInit() {
        this.orders = this.client.getService<OrdersService>("Orders");
      }

      /** Reaches the gRPC service too, so a warm-up gets both their batches in. */
      @Get("health")
      health() {
        return firstValueFrom(this.orders.findOne({ id: "health" }));
      }

      @Get("orders/:id")
      order(@Param("id") id: string) {
        return firstValueFrom(this.orders.findOne({ id }));
      }
    }

    let apiApp: INestApplication;
    let ordersApp: INestMicroservice;
    let apiUrl = "";

    beforeAll(async () => {
      const api = createObserveModule();
      const orders = createObserveModule();

      @Module({
        imports: [
          orders.ObserveModule.forRoot(
            reporting(collector, receiver, "orders-grpc"),
          ),
        ],
        controllers: [OrdersGrpcController],
      })
      class OrdersModule {}

      @Module({
        imports: [
          api.ObserveModule.forRoot(reporting(collector, receiver, "api-grpc")),
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
      await untilIngesting(apiApp, apiUrl, 15_000, [ordersApp]);
    }, 30_000);

    afterAll(async () => {
      await apiApp?.close();
      await ordersApp?.close();
    });

    it("puts the call's span under the span that made it, read off the call's metadata", async () => {
      const response = await fetch(`${apiUrl}/orders/grpc-1`);
      expect(response.status).toBe(200);

      const front = await receiver.waitForSpan(
        (span) => span.attributes["url.path"] === "/orders/grpc-1",
      );
      const call = await receiver.waitForSpan(
        (span) =>
          span.traceId === front.traceId &&
          span.kind === SpanKind.SERVER &&
          span.spanId !== front.spanId,
      );

      const ancestry = ancestryOf(receiver, call);
      expect(ancestry).toContain("ApiController.order");
      expect(ancestry.at(-1)).toBe("GET /orders/:id");
      expect(call.flags).toBe(0x301);
    });
  });
});
