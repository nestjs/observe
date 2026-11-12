// First, before anything that loads http, express, @nestjs/core or kafkajs:
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
  ClientKafka,
  ClientsModule,
  Ctx,
  EventPattern,
  KafkaContext,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import { Admin, Kafka, logLevel } from "kafkajs";
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

const KAFKA_HOST = process.env.KAFKA_HOST ?? "127.0.0.1";
const KAFKA_PORT = Number(process.env.KAFKA_PORT ?? 9092);
const BROKERS = [`${KAFKA_HOST}:${KAFKA_PORT}`];

/** kafkajs has no in-memory broker, so the suite runs only where Kafka answers. */
const kafkaReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: KAFKA_HOST, port: KAFKA_PORT });
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
 * Kafka record headers (12.3.3 and later) - see the broker packets suite.
 */
const frameworkCarriesMetadata =
  typeof (KafkaContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

/** A topic of the run's own, which the consumer reads from the beginning. */
const TOPIC = `observe-kafkajs-otel-e2e-${process.pid}-${Date.now()}`;

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
  /** The record's `traceparent` header, as Nest decoded it. */
  traceparent: unknown;
  /** The packet metadata Nest read off the record's headers. */
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
  @EventPattern<string>(TOPIC)
  async confirm(@Payload() order: { id: string }, @Ctx() ctx: KafkaContext) {
    const traceparent = ctx.getMessage().headers?.["traceparent"];
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
  constructor(@Inject("ORDERS") private readonly orders: ClientKafka) {}

  @Get("orders/:id/confirm")
  async confirm(@Param("id") id: string) {
    await lastValueFrom(this.orders.emit(TOPIC, { id }));
    return { emitted: id };
  }
}

/**
 * Two Nest services that run the OpenTelemetry Node SDK, its kafkajs
 * instrumentation included, as well as Observe, with `openTelemetry` on: an
 * HTTP request emits a Kafka event, whose handler calls a service that
 * exports to an OpenTelemetry backend.
 *
 *   client → api (Nest + OpenTelemetry + Observe) → Kafka → orders (Nest + OpenTelemetry + Observe) → inventory (OpenTelemetry)
 *
 * From `@nestjs/microservices` 12.3.3 the agent puts a `traceparent` in the
 * packet's metadata, beside `x-request-id`, and Nest sends both as record
 * headers. The instrumentation writes its own over it as it sends the
 * record - its producer span's - so the record carries one, and the
 * consumer runs each message in a consumer span that continues it. That
 * span is in the trace the agent hands the handler on in, so the agent
 * leaves the handler in it - see `continueHandedOnTrace` - and the
 * handler's spans nest under it:
 *
 *   server GET /orders/:id/confirm
 *     … the handler that emits the event
 *         producer send <topic>      ← named by the record's traceparent
 *           consumer process <topic> ← the handler runs in it
 *             client GET /stock/:id  ← the handler's call
 *               server GET /stock/:id (inventory)
 */
describe.runIf(kafkaReachable && frameworkCarriesMetadata)(
  "OpenTelemetry's kafkajs instrumentation in two Nest services",
  () => {
    const api = createObserveModule();
    const orders = createObserveModule();
    let admin: Admin;
    let otlp: OtlpReceiver;
    let inventory: OpenTelemetryService;
    let collector: FakeCollector;
    let apiApp: INestApplication;
    let ordersApp: INestMicroservice;
    let apiUrl = "";

    beforeAll(async () => {
      // The topic is there before the consumer subscribes: a KRaft broker
      // answers UNKNOWN_TOPIC_OR_PARTITION for a topic it is still creating,
      // and kafkajs's subscribe gives up on it rather than retry.
      admin = new Kafka({
        clientId: "setup",
        brokers: BROKERS,
        logLevel: logLevel.NOTHING,
      }).admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic: TOPIC, numPartitions: 1 }],
        waitForLeaders: true,
      });

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
              transport: Transport.KAFKA,
              options: {
                client: { clientId: "api", brokers: BROKERS },
                // Events only: no consumer for replies.
                producerOnlyMode: true,
              },
            },
          ]),
        ],
        controllers: [ApiController],
      })
      class ApiModule {}

      // From the topic's first record: with no offset committed for its
      // group, a consumer otherwise starts at the topic's end once it is
      // assigned the partition - past an event sent before then.
      ordersApp = await NestFactory.createMicroservice(OrdersModule, {
        transport: Transport.KAFKA,
        options: {
          client: { clientId: "orders", brokers: BROKERS },
          consumer: { groupId: TOPIC },
          subscribe: { fromBeginning: true },
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
      await apiApp.get<ClientKafka>("ORDERS").connect();
    }, 60_000);

    afterAll(async () => {
      await apiApp?.close();
      await ordersApp?.close();
      await admin?.deleteTopics({ topics: [TOPIC] }).catch(() => undefined);
      await admin?.disconnect();
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
        15_000,
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
      const producer = await spanFrom(
        nestSpans,
        inTrace("producer"),
        "the kafkajs instrumentation's producer span",
      );
      // Ends once the handler has returned.
      const consumer = await spanFrom(
        nestSpans,
        inTrace("consumer"),
        "the kafkajs instrumentation's consumer span",
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

      // One traceparent on the record, the instrumentation's producer
      // span's: it writes its own over the agent's as it sends the record.
      // Nest hands the handler the headers decoded, and a header sent twice
      // as the two values joined by a comma, which is no traceparent...
      expect(typeof run.traceparent).toBe("string");
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
        (snapshot) => snapshot.p === "KAFKA",
        "the orders service's snapshot for the message",
      );
      expect(handled.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  },
);
