// First, before anything that loads http, express or @nestjs/core: the SDK's
// instrumentations patch only what loads after it starts.
import {
  openTelemetrySpans,
  shutdownOpenTelemetry,
} from "../testing/opentelemetry-sdk.js";
import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientsModule,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import type { Job, Queue } from "bullmq";
import { connect } from "node:net";
import { firstValueFrom } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  freePort,
  listenOnLoopback,
  waitFor,
} from "../testing/observe-harness.js";
import {
  asUuid,
  exportedSpanOf,
  pathOf,
  ReceivedRequest,
  serverSpanFrom,
  snapshotAt,
  spanFrom,
  untilIngesting,
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

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** BullMQ has no in-memory driver, so the queue suite runs only where Redis answers. */
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
 * (12.0.4 and later), which is how a TCP or Redis message carries the trace
 * at all.
 */
const frameworkCarriesMetadata =
  typeof (ClientProxy.prototype as { setOnDispatchHook?: unknown })
    .setOnDispatchHook === "function";

const QUEUE_NAME = `observe-otel-e2e-${process.pid}`;
// Bound at import time: the client module is configured by a decorator.
const TCP_PORT = await freePort();

let inventoryUrl = "";

@Injectable()
class InventoryClient {
  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

/** What the inventory service received from each job, by order id. */
const receivedFromJobs = new Map<string, ReceivedRequest>();

@Processor(QUEUE_NAME)
class ConfirmationProcessor extends WorkerHost {
  constructor(private readonly inventory: InventoryClient) {
    super();
  }

  async process(job: Job<{ id: string }>) {
    receivedFromJobs.set(job.data.id, await this.inventory.stock(job.data.id));
  }
}

@Controller()
class QueueingOrdersController {
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

@Controller()
class StockController {
  constructor(private readonly inventory: InventoryClient) {}

  @MessagePattern("ping")
  ping() {
    return "pong";
  }

  @MessagePattern("reserve")
  reserve(@Payload() id: string) {
    return this.inventory.stock(id);
  }
}

@Controller()
class ReservingOrdersController {
  constructor(@Inject("STOCK") private readonly stock: ClientProxy) {}

  /** Reaches the stock service too, so a warm-up gets both their batches in. */
  @Get("health")
  async health() {
    return firstValueFrom(this.stock.send<string>("ping", {}));
  }

  @Get("orders/:id/reserve")
  reserve(@Param("id") id: string) {
    return firstValueFrom(this.stock.send<ReceivedRequest>("reserve", id));
  }
}

/**
 * A Nest service that runs the OpenTelemetry Node SDK as well as Observe,
 * with `openTelemetry` on, handing work on to a queue job and to a TCP
 * microservice. OpenTelemetry has no instrumentation for either hop, so
 * inside the job and the message handler it has no span from the request -
 * and their calls out would carry a `traceparent` for a trace of their own,
 * which every service downstream then follows, Observe ones included.
 *
 *   client → orders (Nest + OpenTelemetry + Observe) → BullMQ job / TCP handler → inventory (OpenTelemetry)
 *
 * Both hops carry the request's trace: the job and the handler are reported
 * under its trace id, the SDK's spans inside them join it, and so does the
 * service they call. End to end, through the agent's own worker and a fake
 * collector, with the SDK's spans kept in memory and the inventory
 * service's exported over OTLP.
 */
describe("OpenTelemetry in a Nest service, across its queue jobs and microservice messages", () => {
  let otlp: OtlpReceiver;
  let inventory: OpenTelemetryService;
  let collector: FakeCollector;

  beforeAll(async () => {
    otlp = await startOtlpReceiver();
    inventory = await startOpenTelemetryService({ name: "inventory", otlp });
    inventoryUrl = inventory.url;
    collector = await startFakeCollector();
  }, 60_000);

  afterAll(async () => {
    await inventory?.stop();
    await collector?.close();
    await otlp?.close();
    await shutdownOpenTelemetry();
  });

  /** The agent's options for one of the Nest services. */
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

  /**
   * A request from outside any trace: the SDK instruments this process's own
   * `fetch` too, and would otherwise start a trace for the call and send its
   * `traceparent` along.
   */
  const get = async <T>(url: string): Promise<T> => {
    const response = await context.with(suppressTracing(context.active()), () =>
      fetch(url),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  };

  /** Every span the SDK in this process kept - both Nest services'. */
  const nestSpans = (): ExportedSpan[] =>
    openTelemetrySpans
      .getFinishedSpans()
      .map((span) => exportedSpanOf(span, "orders"));

  /** The SDK's span for a call out to the inventory service. */
  const callTo = (path: string) =>
    spanFrom(
      nestSpans,
      (span) => span.kind === "client" && pathOf(span) === path,
      `the SDK's span for the call to ${path}`,
    );

  /**
   * What OpenTelemetry has to show for a request that handed work on: the
   * trace the SDK started for it, and the spans further down the line.
   */
  const expectOneTrace = async (requestPath: string, callPath: string) => {
    const { traceId } = await serverSpanFrom(nestSpans, "orders", requestPath);
    const call = await callTo(callPath);
    const inventorySpan = await serverSpanFrom(
      () => otlp.spans,
      "inventory",
      callPath,
    );

    // The SDK's span for the call nests in the request's trace...
    expect(call.traceId).toBe(traceId);
    expect(
      nestSpans().some(
        (span) => span.spanId === call.parentSpanId && span.traceId === traceId,
      ),
    ).toBe(true);
    // ...and the service it called continues it, under that span.
    expect(inventorySpan.traceId).toBe(traceId);
    expect(inventorySpan.parentSpanId).toBe(call.spanId);
    return traceId;
  };

  describe.skipIf(!redisReachable)("a BullMQ job", () => {
    const { ObserveModule, ObserveInstrument } = createObserveModule();
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      @Module({
        imports: [
          BullModule.forRoot({
            connection: { host: REDIS_HOST, port: REDIS_PORT },
          }),
          BullModule.registerQueue({ name: QUEUE_NAME }),
          ObserveModule.forRoot(observeOptions("orders")),
        ],
        controllers: [QueueingOrdersController],
        providers: [InventoryClient, ConfirmationProcessor],
      })
      class QueueingOrdersModule {}

      app = await NestFactory.create(QueueingOrdersModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      url = await listenOnLoopback(app);
      await untilIngesting(app, url);
    }, 60_000);

    afterAll(async () => {
      await app
        ?.get<Queue>(`BullQueue_${QUEUE_NAME}`)
        .obliterate({ force: true })
        .catch(() => undefined);
      await app?.close();
    });

    it("runs in the request's trace in both tools, and the service it calls continues it", async () => {
      await get(`${url}/orders/job-1/confirm`);
      await waitFor(
        () => receivedFromJobs.has("job-1"),
        10_000,
        "the job to call the inventory service",
      );
      const received = receivedFromJobs.get("job-1")!;
      const { traceId } = await serverSpanFrom(
        nestSpans,
        "orders",
        "/orders/job-1/confirm",
      );

      // The call the job made carries the request's trace, in both headers.
      expect(readTraceContext(received.headers)?.traceId).toBe(traceId);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      await expectOneTrace("/orders/job-1/confirm", "/stock/job-1");
      // And Observe reports the job under the request's trace id.
      const job = await jobAt(collector, "confirm-order");
      expect(job.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  });

  describe.runIf(frameworkCarriesMetadata)("a TCP message", () => {
    const api = createObserveModule();
    const stock = createObserveModule();
    let apiApp: INestApplication;
    let stockApp: INestMicroservice;
    let apiUrl = "";

    beforeAll(async () => {
      @Module({
        imports: [stock.ObserveModule.forRoot(observeOptions("stock"))],
        controllers: [StockController],
        providers: [InventoryClient],
      })
      class StockModule {}

      @Module({
        imports: [
          api.ObserveModule.forRoot(observeOptions("orders")),
          ClientsModule.register([
            {
              name: "STOCK",
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: TCP_PORT },
            },
          ]),
        ],
        controllers: [ReservingOrdersController],
      })
      class ReservingOrdersModule {}

      stockApp = await NestFactory.createMicroservice(StockModule, {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: TCP_PORT },
        instrument: stock.ObserveInstrument,
        logger: false,
      } as never);
      await stockApp.listen();
      apiApp = await NestFactory.create(ReservingOrdersModule, {
        instrument: api.ObserveInstrument,
        logger: false,
      });
      apiUrl = await listenOnLoopback(apiApp);

      // `/health` reaches the stock service too.
      await untilIngesting(apiApp, apiUrl, 15_000, [stockApp]);
    }, 60_000);

    afterAll(async () => {
      await apiApp?.close();
      await stockApp?.close();
    });

    it("runs its handler in the request's trace in both tools, and the service it calls continues it", async () => {
      const received = await get<ReceivedRequest>(
        `${apiUrl}/orders/tcp-1/reserve`,
      );
      const { traceId } = await serverSpanFrom(
        nestSpans,
        "orders",
        "/orders/tcp-1/reserve",
      );

      // The call the handler made carries the request's trace, in both headers.
      expect(readTraceContext(received.headers)?.traceId).toBe(traceId);
      expect(received.headers["x-request-id"]).toBe(asUuid(traceId));
      await expectOneTrace("/orders/tcp-1/reserve", "/stock/tcp-1");
      // And Observe reports the handler under the request's trace id.
      const handled = await snapshotAt(
        collector,
        (snapshot) => snapshot.op === "reserve",
        "the stock service's snapshot for the message",
      );
      expect(handled.p).toBe("TCP");
      expect(handled.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  });
});

/** A job as the encoders put it on the wire. */
interface WireJob {
  ti: string;
  n: string;
  s?: string;
}

/** Waits for the job named `name` in a batch the collector received. */
async function jobAt(collector: FakeCollector, name: string): Promise<WireJob> {
  const find = () =>
    collector.batches
      .flatMap((batch) => (batch.jobs ?? []) as WireJob[])
      .find((job) => job.n === name);
  await waitFor(
    () => find() !== undefined,
    8_000,
    `the job "${name}" at the collector`,
  );
  return find()!;
}
