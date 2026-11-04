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
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import type { Job, Queue } from "bullmq";
import { BullMQOtel } from "bullmq-otel";
import { connect } from "node:net";
import { JOB_TRACE_CONTEXT_OPTION_KEY } from "../observe.constants.js";
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

/** BullMQ has no in-memory driver, so the suite runs only where Redis answers. */
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

const QUEUE_NAME = `observe-bullmq-otel-e2e-${process.pid}`;

/**
 * BullMQ's own OpenTelemetry add-on, set up as its README does: handed to
 * the queue and to the worker. Around `Queue.add` it opens a producer span
 * and writes that span's context into the job's options
 * (`opts.telemetry.metadata`, as the SDK's propagator injects it); around
 * the processor it opens a consumer span, as a child of that context, and
 * runs the processor with the consumer span active.
 */
const telemetry = new BullMQOtel({ tracerName: "orders" });

let inventoryUrl = "";

@Injectable()
class InventoryClient {
  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

/** What a job found in its options, and what the service it called received. */
interface JobRun {
  /** The `traceparent` the agent handed on with the job. */
  handedOn: unknown;
  /** The context `bullmq-otel` handed on with it, as the JSON it writes. */
  telemetryMetadata: unknown;
  received: ReceivedRequest;
}

/** Each job's run, by order id. */
const runs = new Map<string, JobRun>();

@Processor(QUEUE_NAME, { telemetry })
class ConfirmationProcessor extends WorkerHost {
  constructor(private readonly inventory: InventoryClient) {
    super();
  }

  async process(job: Job<{ id: string }>) {
    const opts = job.opts as Record<string, unknown> & {
      telemetry?: { metadata?: string };
    };
    const handedOn = opts[JOB_TRACE_CONTEXT_OPTION_KEY];
    const telemetryMetadata = opts.telemetry?.metadata;
    runs.set(job.data.id, {
      handedOn,
      telemetryMetadata,
      received: await this.inventory.stock(job.data.id),
    });
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

/**
 * The BullMQ case of the jobs-and-messages suite, with BullMQ's own
 * OpenTelemetry add-on, `bullmq-otel`, on the queue and on the worker: a Nest
 * service that runs the OpenTelemetry Node SDK as well as Observe, with
 * `openTelemetry` on, hands a request's work on to a job, and the job calls a
 * service that exports to an OpenTelemetry backend.
 *
 *   client → orders (Nest + OpenTelemetry + bullmq-otel + Observe) → BullMQ job → inventory (OpenTelemetry)
 *
 * Both carry the request's trace into the job - the agent in the job option
 * `observeTraceparent`, `bullmq-otel` in `opts.telemetry.metadata` - and
 * both name the same trace, as the agent follows the SDK's ids. They name
 * different parents, though: the agent the span that was active as the job
 * was added, `bullmq-otel` its producer span. In the job the agent runs the
 * processor in the context it handed on, inside `bullmq-otel`'s consumer
 * span, so the job's own spans nest under the span that added it, beside the
 * producer span, and the consumer span holds only BullMQ's own work. This
 * suite pins that, so a change to it is a deliberate one:
 *
 *   server GET /orders/:id/confirm
 *     … the handler that adds the job      ← named by observeTraceparent
 *         producer add <queue>.confirm-order ← named by opts.telemetry.metadata
 *           consumer process <queue>
 *             internal complete <queue>
 *         client GET /stock/:id           ← the job's call
 *           server GET /stock/:id (inventory)
 */
describe.skipIf(!redisReachable)(
  "OpenTelemetry in a Nest service whose BullMQ queue and worker run bullmq-otel",
  () => {
    const { ObserveModule, ObserveInstrument } = createObserveModule();
    let otlp: OtlpReceiver;
    let inventory: OpenTelemetryService;
    let collector: FakeCollector;
    let app: INestApplication;
    let url = "";

    beforeAll(async () => {
      otlp = await startOtlpReceiver();
      inventory = await startOpenTelemetryService({ name: "inventory", otlp });
      inventoryUrl = inventory.url;
      collector = await startFakeCollector();

      @Module({
        imports: [
          BullModule.forRoot({
            connection: { host: REDIS_HOST, port: REDIS_PORT },
          }),
          BullModule.registerQueue({ name: QUEUE_NAME, telemetry }),
          ObserveModule.forRoot({
            appKey: "e2e-key",
            appSecret: "e2e-secret",
            serviceId: "orders",
            endpoint: collector.url,
            flushInterval: 1000,
            runtimeMetrics: false,
            forwardLogs: false,
            openTelemetry: true,
          }),
        ],
        controllers: [OrdersController],
        providers: [InventoryClient, ConfirmationProcessor],
      })
      class OrdersModule {}

      app = await NestFactory.create(OrdersModule, {
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
      await inventory?.stop();
      await collector?.close();
      await otlp?.close();
      await shutdownOpenTelemetry();
    });

    /**
     * A request from outside any trace: the SDK instruments this process's
     * own `fetch` too, and would otherwise start a trace for the call and
     * send its `traceparent` along.
     */
    const get = async (path: string) => {
      const response = await context.with(
        suppressTracing(context.active()),
        () => fetch(`${url}${path}`),
      );
      expect(response.status).toBe(200);
    };

    /** Every span the SDK in this process kept. */
    const nestSpans = (): ExportedSpan[] =>
      openTelemetrySpans
        .getFinishedSpans()
        .map((span) => exportedSpanOf(span, "orders"));

    it("keeps the job in the request's trace in both tools, bullmq-otel's spans included, and nests the job's own spans under the span that added it", async () => {
      await get("/orders/job-1/confirm");
      await waitFor(
        () => runs.has("job-1"),
        10_000,
        "the job to call the inventory service",
      );
      const run = runs.get("job-1")!;
      const request = await serverSpanFrom(
        nestSpans,
        "orders",
        "/orders/job-1/confirm",
      );
      const { traceId } = request;
      const inTrace = (kind: ExportedSpan["kind"]) => (span: ExportedSpan) =>
        span.kind === kind && span.traceId === traceId;
      const producer = await spanFrom(
        nestSpans,
        inTrace("producer"),
        "bullmq-otel's producer span for the job",
      );
      // Ends once BullMQ has moved the job to completed, after the processor.
      const consumer = await spanFrom(
        nestSpans,
        inTrace("consumer"),
        "bullmq-otel's consumer span for the job",
      );
      const call = await spanFrom(
        nestSpans,
        (span) => span.kind === "client" && pathOf(span) === "/stock/job-1",
        "the SDK's span for the job's call",
      );
      const inventorySpan = await serverSpanFrom(
        () => otlp.spans,
        "inventory",
        "/stock/job-1",
      );
      const trace = [...nestSpans(), ...otlp.spans].filter(
        (span) => span.traceId === traceId,
      );

      // The service the job called continues the request's trace, under the
      // job's call: one traceparent, and Observe's id for the trace beside it.
      expect(readTraceContext(run.received.headers)?.traceId).toBe(traceId);
      expect(countHeader(run.received.rawHeaders, "traceparent")).toBe(1);
      expect(run.received.headers["x-request-id"]).toBe(asUuid(traceId));
      expect(call.traceId).toBe(traceId);
      expect(inventorySpan.traceId).toBe(traceId);
      expect(inventorySpan.parentSpanId).toBe(call.spanId);

      // The job carries two W3C contexts, for the one trace: the agent's
      // names the span that was active as the job was added, bullmq-otel's
      // names its producer span - a child of that same span.
      const handedOn = readTraceContext({ traceparent: run.handedOn });
      const bullmqContext = readTraceContext(
        JSON.parse(String(run.telemetryMetadata)) as Record<string, unknown>,
      );
      expect(handedOn?.traceId).toBe(traceId);
      expect(bullmqContext?.traceId).toBe(traceId);
      expect(bullmqContext?.parentSpanId).toBe(producer.spanId);
      const adding = trace.find(
        (span) => span.spanId === handedOn?.parentSpanId,
      );
      expect(adding).toBeDefined();
      expect(producer.parentSpanId).toBe(adding!.spanId);

      // bullmq-otel's spans for the job: one of each, the consumer under the
      // producer.
      expect(trace.filter(inTrace("producer"))).toHaveLength(1);
      expect(trace.filter(inTrace("consumer"))).toHaveLength(1);
      expect(consumer.parentSpanId).toBe(producer.spanId);

      // Pins current behaviour: the job's own spans nest under the span the
      // agent handed on, not under bullmq-otel's consumer span, which holds
      // only what BullMQ itself does once the processor returns.
      expect(call.parentSpanId).toBe(adding!.spanId);
      const underConsumer = descendantsOf(consumer.spanId, trace);
      expect(underConsumer.map((span) => span.spanId)).not.toContain(
        call.spanId,
      );
      expect(underConsumer.some((span) => span.service === "inventory")).toBe(
        false,
      );
      // BullMQ names its spans `<operation> <queue>`: `complete`, here.
      const consumerChildren = trace.filter(
        (span) => span.parentSpanId === consumer.spanId,
      );
      expect(consumerChildren.length).toBeGreaterThan(0);
      expect(
        consumerChildren.filter(
          (span) => !span.name.endsWith(` ${QUEUE_NAME}`),
        ),
      ).toEqual([]);

      // One trace, whole: every span in it but the request's has its parent
      // in it too.
      const ids = new Set(trace.map((span) => span.spanId));
      expect(
        trace
          .filter((span) => !span.parentSpanId || !ids.has(span.parentSpanId))
          .map((span) => span.spanId),
      ).toEqual([request.spanId]);

      // And Observe reports the job under the request's trace id.
      const job = await jobAt(collector, "confirm-order");
      expect(job.ti).toBe(asUuid(traceId));
      expect(collector.violations).toEqual([]);
    });
  },
);

/** Every span under the span `spanId` in `spans`, at any depth. */
function descendantsOf(
  spanId: string,
  spans: ExportedSpan[],
  found: ExportedSpan[] = [],
): ExportedSpan[] {
  for (const span of spans) {
    if (span.parentSpanId === spanId) {
      found.push(span);
      descendantsOf(span.spanId, spans, found);
    }
  }
  return found;
}

/** A job as the encoders put it on the wire. */
interface WireJob {
  ti: string;
  n: string;
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
