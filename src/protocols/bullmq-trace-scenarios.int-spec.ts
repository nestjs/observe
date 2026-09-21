import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Controller, Injectable, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { FlowProducer, type Job, type Queue } from "bullmq";
import { connect } from "net";
import request from "supertest";
import { WebSocket } from "ws";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedJobSnapshots,
  CollectedSnapshots,
  collectJobSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitFor,
  waitForJobSnapshot,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** BullMQ has no in-memory driver, so this suite runs only where Redis answers. */
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

const QUEUE_NAME = `observe-scenarios-${process.pid}`;
const UUID = /^[0-9a-f-]{36}$/;

const { ObserveModule, ObserveInstrument } = createObserveModule();

let flowProducer: FlowProducer;

/** What each run saw as "the current trace id", by job name. */
const seenInside: Array<{ name: string; traceId: string | null }> = [];

@Injectable()
class MailerService {
  deliver() {
    return "delivered";
  }
}

@Processor(QUEUE_NAME, { concurrency: 5 })
class MailProcessor extends WorkerHost {
  constructor(
    private readonly mailer: MailerService,
    private readonly tracer: TracerService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    seenInside.push({
      name: job.name,
      traceId: this.tracer.currentTraceId(),
    });
    if (job.name === "flaky-mail" && job.attemptsMade < 2) {
      throw new Error(`attempt ${job.attemptsMade + 1} failed`);
    }
    if (job.name === "doomed-mail") {
      throw new Error("never succeeds");
    }
    if (job.name === "first-mail") {
      await this.queue.add("follow-up-mail", {});
    }
    if (job.name === "slow-mail") {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return this.mailer.deliver();
  }
}

@Controller()
class CampaignController {
  constructor(@InjectQueue(QUEUE_NAME) private readonly queue: Queue) {}

  @Post("delayed")
  async delayed() {
    await this.queue.add("delayed-mail", {}, { delay: 250 });
    return { ok: true };
  }

  @Post("flaky")
  async flaky() {
    await this.queue.add(
      "flaky-mail",
      {},
      { attempts: 3, backoff: { type: "fixed", delay: 50 } },
    );
    return { ok: true };
  }

  @Post("doomed")
  async doomed() {
    await this.queue.add("doomed-mail", {}, { attempts: 2 });
    return { ok: true };
  }

  @Post("chain")
  async chain() {
    await this.queue.add("first-mail", {});
    return { ok: true };
  }

  @Post("fan-out")
  async fanOut() {
    await this.queue.addBulk(
      Array.from({ length: 5 }, () => ({ name: "slow-mail", data: {} })),
    );
    // Open while all five run beside it, under the id they share.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ok: true };
  }

  @Post("own-options")
  async ownOptions() {
    await this.queue.add(
      "options-mail",
      {},
      { attempts: 4, removeOnComplete: true, priority: 3 },
    );
    return { ok: true };
  }

  @Post("schedule")
  async schedule() {
    await this.queue.upsertJobScheduler(
      "observe-scheduler",
      { every: 150, limit: 2 },
      { name: "scheduled-mail", data: {} },
    );
    return { ok: true };
  }

  @Post("flow")
  async flow() {
    await flowProducer.add({
      name: "flow-parent-mail",
      queueName: QUEUE_NAME,
      children: [{ name: "flow-child-mail", queueName: QUEUE_NAME }],
    });
    return { ok: true };
  }
}

@WebSocketGateway()
class CampaignGateway {
  constructor(
    private readonly tracer: TracerService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {}

  @SubscribeMessage("notify")
  async notify() {
    await this.queue.add("socket-mail", {});
    return { event: "queued", data: this.tracer.currentTraceId() };
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: REDIS_HOST, port: REDIS_PORT },
    }),
    BullModule.registerQueue({ name: QUEUE_NAME }),
    ObserveModule.forRoot(testObserveOptions()),
  ],
  controllers: [CampaignController],
  providers: [MailerService, MailProcessor, CampaignGateway],
})
class QueueScenariosModule {}

/**
 * Trace inheritance through BullMQ, past the happy path: jobs that wait, fail,
 * retry, fan out, chain, repeat, and arrive from somewhere other than an HTTP
 * request.
 *
 * The id rides in the job's options, so every scenario is a question about
 * what BullMQ does with those options - re-reads them on a retry, copies them
 * to a scheduler's next iteration, bypasses `Queue#add` altogether for a flow -
 * and only a real queue answers it.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: BullMQ trace inheritance scenarios",
  () => {
    let app: NestExpressApplication;
    let requests: CollectedSnapshots;
    let jobs: CollectedJobSnapshots;
    let queue: Queue;
    let port: number;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(
        QueueScenariosModule,
        { instrument: ObserveInstrument, logger: false },
      );
      app.useWebSocketAdapter(new WsAdapter(app));
      requests = collectSnapshots(app);
      jobs = collectJobSnapshots(app);
      port = await freePort();
      await app.listen(port);
      queue = app.get<Queue>(`BullQueue_${QUEUE_NAME}`);
      flowProducer = new FlowProducer({
        connection: { host: REDIS_HOST, port: REDIS_PORT },
      });
    });

    afterAll(async () => {
      await queue?.removeJobScheduler("observe-scheduler").catch(() => false);
      await flowProducer?.close().catch(() => undefined);
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await app?.close();
    });

    const post = (path: string, traceId: string) =>
      request(app.getHttpServer())
        .post(path)
        .set("x-request-id", traceId)
        .expect(201);

    const runsOf = (name: string) =>
      jobs.items.filter((item) => item.name === name);

    it("carries the id across a delay, and does not count the delay as time spent waiting", async () => {
      await post("/delayed", "delayed-trace-1");

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "delayed-mail",
      );
      expect(job.traceId).toBe("delayed-trace-1");
      expect(job.status).toBe("completed");
      expect(job.waitDuration).toBeLessThan(200);
    });

    it("keeps the inherited id on every attempt of a retried job, each attempt its own snapshot", async () => {
      await post("/flaky", "flaky-trace-1");

      await waitFor(
        () => runsOf("flaky-mail").length >= 3,
        5_000,
        "three attempts of flaky-mail",
      );
      const attempts = runsOf("flaky-mail");

      expect(attempts.map((attempt) => attempt.traceId)).toEqual([
        "flaky-trace-1",
        "flaky-trace-1",
        "flaky-trace-1",
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        "failed",
        "failed",
        "completed",
      ]);
      expect(attempts.map((attempt) => attempt.attemptsMade)).toEqual([
        0, 1, 2,
      ]);
      expect(attempts.every((attempt) => attempt.maxAttempts === 3)).toBe(true);
      // The handler saw the inherited id each time, too.
      expect(
        seenInside
          .filter((seen) => seen.name === "flaky-mail")
          .map((seen) => seen.traceId),
      ).toEqual(["flaky-trace-1", "flaky-trace-1", "flaky-trace-1"]);
    });

    it("keeps the inherited id on a job that fails for good, with the error on its root span", async () => {
      await post("/doomed", "doomed-trace-1");

      await waitFor(
        () => runsOf("doomed-mail").length >= 2,
        5_000,
        "both attempts of doomed-mail",
      );
      const attempts = runsOf("doomed-mail");

      expect(attempts.map((attempt) => attempt.traceId)).toEqual([
        "doomed-trace-1",
        "doomed-trace-1",
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        "failed",
        "failed",
      ]);
      expect(attempts[1].traces[0].error).toBeTruthy();
    });

    it("passes the id down a chain: a job enqueued by a job reports under the request that started it", async () => {
      await post("/chain", "chain-trace-1");

      const first = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "first-mail",
      );
      const followUp = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "follow-up-mail",
      );
      expect(first.traceId).toBe("chain-trace-1");
      expect(followUp.traceId).toBe("chain-trace-1");
    });

    it("runs five jobs and their open request under one id at once, and loses none of the six snapshots", async () => {
      await post("/fan-out", "fan-out-trace-1");

      await waitFor(
        () => runsOf("slow-mail").length >= 5,
        5_000,
        "five slow-mail runs",
      );
      const http = await waitForSnapshot(
        requests,
        (item) => item.operationId === "/fan-out",
      );

      expect(http.traceId).toBe("fan-out-trace-1");
      expect(http.traces[0]).toMatchObject({
        className: "CampaignController",
        methodKey: "fanOut",
      });
      const runs = runsOf("slow-mail");
      expect(runs).toHaveLength(5);
      for (const run of runs) {
        expect(run.traceId).toBe("fan-out-trace-1");
        expect(run.status).toBe("completed");
        // Each run kept its own spans: none leaked into a sibling's tree.
        expect(run.traces).toHaveLength(1);
        expect(run.traces[0].children).toHaveLength(1);
      }
    });

    it("adds its id beside the application's own job options, not in place of them", async () => {
      await post("/own-options", "options-trace-1");

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "options-mail",
      );
      expect(job.traceId).toBe("options-trace-1");
      expect(job.maxAttempts).toBe(4);
    });

    it("gives a job enqueued from a gateway handler the id of that message", async () => {
      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await new Promise((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      const reply = new Promise<{ data: string }>((resolve) =>
        client.once("message", (raw) => resolve(JSON.parse(String(raw)))),
      );
      client.send(JSON.stringify({ event: "notify" }));
      const messageTraceId = (await reply).data;
      client.close();

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "socket-mail",
      );
      const message = await waitForSnapshot(
        requests,
        (item) => item.operationId === "CampaignGateway:notify",
      );
      expect(messageTraceId).toMatch(UUID);
      expect(message.traceId).toBe(messageTraceId);
      expect(job.traceId).toBe(messageTraceId);
    });

    it("gives every firing of a job scheduler an id of its own, not the id of the request that registered it", async () => {
      await post("/schedule", "schedule-trace-1");

      await waitFor(
        () => runsOf("scheduled-mail").length >= 2,
        5_000,
        "two scheduled-mail firings",
      );
      const firings = runsOf("scheduled-mail");

      for (const firing of firings) {
        expect(firing.traceId).toMatch(UUID);
        expect(firing.traceId).not.toBe("schedule-trace-1");
      }
      expect(new Set(firings.map((firing) => firing.traceId)).size).toBe(
        firings.length,
      );
    });

    it("KNOWN GAP: jobs added through a FlowProducer do not inherit - a flow never passes through Queue#add", async () => {
      await post("/flow", "flow-trace-1");

      const child = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "flow-child-mail",
      );
      const parent = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "flow-parent-mail",
      );

      // Both still run and report; each under an id minted for the run.
      expect(child.status).toBe("completed");
      expect(parent.status).toBe("completed");
      for (const job of [child, parent]) {
        expect(job.traceId).toMatch(UUID);
        expect(job.traceId).not.toBe("flow-trace-1");
      }
      expect(child.traceId).not.toBe(parent.traceId);
    });
  },
);
