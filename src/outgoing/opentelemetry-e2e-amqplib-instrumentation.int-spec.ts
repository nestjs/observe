// First, before anything that loads http, express, @nestjs/core or amqplib:
// the SDK's instrumentations patch only what loads after it starts.
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
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientRMQ,
  ClientsModule,
  Ctx,
  EventPattern,
  Payload,
  RmqContext,
  Transport,
} from "@nestjs/microservices";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { connect } from "node:net";
import { lastValueFrom } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback, waitFor } from "../testing/observe-harness.js";
import {
  asUuid,
  countHeader,
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

const RABBITMQ_HOST = process.env.RABBITMQ_HOST ?? "127.0.0.1";
const RABBITMQ_PORT = Number(process.env.RABBITMQ_PORT ?? 5672);
const RABBITMQ_URL = `amqp://${RABBITMQ_HOST}:${RABBITMQ_PORT}`;

/** amqplib has no in-memory broker, so the suite runs only where RabbitMQ answers. */
const rabbitmqReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: RABBITMQ_HOST, port: RABBITMQ_PORT });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata as
 * AMQP message headers (12.3.3 and later) - see the broker packets suite.
 */
const frameworkCarriesMetadata =
  typeof (RmqContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

/**
 * A queue of the run's own, gone once its consumer is: both services assert
 * it, so with the same options.
 */
const QUEUE = `observe-amqplib-otel-e2e-${process.pid}-${Date.now()}`;
const QUEUE_OPTIONS = { durable: false, autoDelete: true };
const PATTERN = "order.confirmed";

let inventoryUrl = "";

@Injectable()
class InventoryClient {
  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

/** What a message's handler found on it, and what the service it called received. */
interface MessageRun {
  /** The message's `traceparent` header, as amqplib delivered it. */
  traceparent: unknown;
  /** The packet metadata Nest read off the message's headers. */
  metadata: Record<string, string> | undefined;
  received: ReceivedRequest;
}

/** Each message's run, by order id. */
const runs = new Map<string, MessageRun>();

@Controller()
class ConfirmationsController {
  constructor(private readonly inventory: InventoryClient) {}

  // Named, the pattern's type picks the untyped signature: the one for typed
  // events takes no handler that names its context's type.
  // oxlint-disable-next-line typescript/no-unnecessary-type-arguments -- it picks the signature
  @EventPattern<string>(PATTERN)
  async confirm(@Payload() order: { id: string }, @Ctx() ctx: RmqContext) {
    const message = ctx.getMessage() as {
      properties: { headers?: Record<string, unknown> };
    };
    const traceparent = message.properties.headers?.["traceparent"];
    const metadata = ctx.getMetadata();
    runs.set(order.id, {
      traceparent,
      metadata,
      received: await this.inventory.stock(order.id),
    });
  }
}

@Controller()
class ApiController {
  constructor(@Inject("ORDERS") private readonly orders: ClientRMQ) {}

  @Get("orders/:id/confirm")
  async confirm(@Param("id") id: string) {
    await lastValueFrom(this.orders.emit(PATTERN, { id }));
    return { emitted: id };
  }
}

/**
 * Two Nest services that run the OpenTelemetry Node SDK, its amqplib
 * instrumentation included, as well as Observe, with `openTelemetry` on: an
 * HTTP request emits a RabbitMQ event, whose handler calls a service that
 * exports to an OpenTelemetry backend.
 *
 *   client → api (Nest + OpenTelemetry + Observe) → RabbitMQ → orders (Nest + OpenTelemetry + Observe) → inventory (OpenTelemetry)
 *
 * From `@nestjs/microservices` 12.3.3 the agent puts a `traceparent` in the
 * packet's metadata, beside `x-request-id`, and Nest sends both as AMQP
 * message headers. The instrumentation writes its own over it as it
 * publishes the message - its producer span's - so the message carries one,
 * and the consumer runs each message in a consumer span that continues it.
 * That span is in the trace the agent hands the handler on in, so the agent
 * leaves the handler in it - see `continueHandedOnTrace` - and the
 * handler's spans nest under it:
 *
 *   server GET /orders/:id/confirm
 *     … the handler that emits the event
 *         producer publish <default>   ← named by the message's traceparent
 *           consumer <queue> process   ← the handler runs in it
 *             client GET /stock/:id    ← the handler's call
 *               server GET /stock/:id (inventory)
 *
 * Nest consumes without acknowledgements by default, so the instrumentation
 * ends the consumer span as soon as Nest has taken the message, before the
 * handler has run: it is a parent here, not a measure of the handler.
 */
describe.runIf(rabbitmqReachable && frameworkCarriesMetadata)(
  "OpenTelemetry's amqplib instrumentation in two Nest services",
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
        controllers: [ConfirmationsController],
        providers: [InventoryClient],
      })
      class OrdersModule {}

      @Module({
        imports: [
          api.ObserveModule.forRoot(observeOptions("api")),
          ClientsModule.register([
            {
              name: "ORDERS",
              transport: Transport.RMQ,
              options: {
                urls: [RABBITMQ_URL],
                queue: QUEUE,
                queueOptions: QUEUE_OPTIONS,
              },
            },
          ]),
        ],
        controllers: [ApiController],
      })
      class ApiModule {}

      ordersApp = await NestFactory.createMicroservice(OrdersModule, {
        transport: Transport.RMQ,
        options: {
          urls: [RABBITMQ_URL],
          queue: QUEUE,
          queueOptions: QUEUE_OPTIONS,
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
      await apiApp.get<ClientRMQ>("ORDERS").connect();
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

    it("carries one traceparent and runs the handler under the instrumentation's consumer span, in the request's trace in both tools", async () => {
      // From outside any trace: the SDK instruments this process's own
      // `fetch` too.
      const response = await context.with(
        suppressTracing(context.active()),
        () => fetch(`${apiUrl}/orders/7/confirm`),
      );
      expect(response.status).toBe(200);
      await waitFor(
        () => runs.has("7"),
        10_000,
        "the handler to call the inventory service",
      );
      const run = runs.get("7")!;

      const request = await serverSpanFrom(
        nestSpans,
        "orders",
        "/orders/7/confirm",
      );
      const { traceId } = request;
      const inTrace = (kind: ExportedSpan["kind"]) => (span: ExportedSpan) =>
        span.kind === kind && span.traceId === traceId;
      // Ends once the broker has confirmed the message.
      const producer = await spanFrom(
        nestSpans,
        inTrace("producer"),
        "the amqplib instrumentation's producer span",
      );
      const consumer = await spanFrom(
        nestSpans,
        inTrace("consumer"),
        "the amqplib instrumentation's consumer span",
      );
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
      const trace = [...nestSpans(), ...otlp.spans].filter(
        (span) => span.traceId === traceId,
      );

      // One traceparent on the message, the instrumentation's producer
      // span's: it writes its own over the agent's as it publishes the
      // message, into the one header table...
      const delivered = readTraceContext({ traceparent: run.traceparent });
      expect(delivered?.traceId).toBe(traceId);
      expect(delivered?.parentSpanId).toBe(producer.spanId);
      // ...the one the agent reads back off the packet's metadata, beside
      // Observe's id for the trace...
      expect(run.metadata?.["traceparent"]).toBe(run.traceparent);
      expect(run.metadata?.["x-request-id"]).toBe(asUuid(traceId));
      // ...which the consumer span continues...
      expect(trace.filter(inTrace("producer"))).toHaveLength(1);
      expect(trace.filter(inTrace("consumer"))).toHaveLength(1);
      expect(consumer.parentSpanId).toBe(producer.spanId);
      // ...and the handler's call under the consumer span, not beside it.
      expect(call.traceId).toBe(traceId);
      expect(call.parentSpanId).toBe(consumer.spanId);
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(call.spanId);
      expect(readTraceContext(run.received.headers)?.traceId).toBe(traceId);
      expect(countHeader(run.received.rawHeaders, "traceparent")).toBe(1);
      expect(run.received.headers["x-request-id"]).toBe(asUuid(traceId));

      // One trace, whole: every span in it but the request's has its parent
      // in it too.
      const ids = new Set(trace.map((span) => span.spanId));
      expect(
        trace
          .filter((span) => !span.parentSpanId || !ids.has(span.parentSpanId))
          .map((span) => span.spanId),
      ).toEqual([request.spanId]);

      // And Observe reports the handler under the request's trace id.
      const handled = await snapshotAt(
        collector,
        (snapshot) => snapshot.p === "RMQ",
        "the orders service's snapshot for the message",
      );
      expect(handled.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  },
);
