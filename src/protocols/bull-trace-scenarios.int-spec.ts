import { BullModule, InjectQueue, Process, Processor } from "@nestjs/bull";
import { Controller, Injectable, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Job, Queue } from "bull";
import { connect } from "net";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedJobSnapshots,
  CollectedSnapshots,
  collectJobSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitFor,
  waitForJobSnapshot,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

/** Bull has no in-memory driver, so this suite runs only where Redis answers. */
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

const QUEUE_NAME = `observe-bull-scenarios-${process.pid}`;
const UNNAMED_QUEUE_NAME = `observe-bull-unnamed-${process.pid}`;
const UUID = /^[0-9a-f-]{36}$/;

const { ObserveModule, ObserveInstrument } = createObserveModule();

const seenInside: Array<{ name: string; traceId: string | null }> = [];

@Injectable()
class MailerService {
  deliver() {
    return "delivered";
  }
}

@Processor(QUEUE_NAME)
class MailProcessor {
  constructor(
    private readonly mailer: MailerService,
    private readonly tracer: TracerService,
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
  ) {}

  @Process("delayed-mail")
  async delayed(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("flaky-mail")
  async flaky(job: Job) {
    seenInside.push({
      name: job.name,
      traceId: this.tracer.currentTraceId(),
    });
    if (job.attemptsMade < 2) {
      throw new Error(`attempt ${job.attemptsMade + 1} failed`);
    }
    return this.mailer.deliver();
  }

  @Process("first-mail")
  async first(_job: Job) {
    await this.queue.add("follow-up-mail", {});
    return this.mailer.deliver();
  }

  @Process("follow-up-mail")
  async followUp(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("repeating-mail")
  async repeating(_job: Job) {
    return this.mailer.deliver();
  }

  @Process({ name: "slow-mail", concurrency: 3 })
  async slow(_job: Job) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return this.mailer.deliver();
  }
}

@Processor(UNNAMED_QUEUE_NAME)
class UnnamedProcessor {
  constructor(private readonly mailer: MailerService) {}

  @Process()
  async handle(_job: Job) {
    return this.mailer.deliver();
  }
}

@Controller()
class CampaignController {
  constructor(
    @InjectQueue(QUEUE_NAME) private readonly queue: Queue,
    @InjectQueue(UNNAMED_QUEUE_NAME) private readonly unnamed: Queue,
  ) {}

  @Post("delayed")
  async delayed() {
    await this.queue.add("delayed-mail", {}, { delay: 250 });
    return { ok: true };
  }

  @Post("flaky")
  async flaky() {
    await this.queue.add("flaky-mail", {}, { attempts: 3, backoff: 50 });
    return { ok: true };
  }

  @Post("chain")
  async chain() {
    await this.queue.add("first-mail", {});
    return { ok: true };
  }

  @Post("repeat")
  async repeat() {
    await this.queue.add(
      "repeating-mail",
      {},
      { repeat: { every: 200, limit: 2 } },
    );
    return { ok: true };
  }

  @Post("fan-out")
  async fanOut() {
    await this.queue.addBulk(
      Array.from({ length: 3 }, () => ({ name: "slow-mail", data: {} })),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { ok: true };
  }

  @Post("unnamed")
  async addUnnamed() {
    // Bull's other two call shapes: no name, with and without options.
    await this.unnamed.add({ shape: "data-only" });
    await this.unnamed.add({ shape: "data-and-opts" }, { attempts: 2 });
    return { ok: true };
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      redis: { host: REDIS_HOST, port: REDIS_PORT },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAME },
      { name: UNNAMED_QUEUE_NAME },
    ),
    ObserveModule.forRoot(testObserveOptions()),
  ],
  controllers: [CampaignController],
  providers: [MailerService, MailProcessor, UnnamedProcessor],
})
class BullScenariosModule {}

/**
 * The BullMQ inheritance scenarios again, on the original Bull - whose `add`
 * takes its arguments in three shapes, whose repeatable jobs are still an
 * option of `add`, and whose retries re-read the job from Redis by a
 * different path.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: @nestjs/bull trace inheritance scenarios",
  () => {
    let app: NestExpressApplication;
    let requests: CollectedSnapshots;
    let jobs: CollectedJobSnapshots;
    let queue: Queue;
    let unnamed: Queue;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(
        BullScenariosModule,
        { instrument: ObserveInstrument, logger: false },
      );
      requests = collectSnapshots(app);
      jobs = collectJobSnapshots(app);
      await app.init();
      queue = app.get<Queue>(`BullQueue_${QUEUE_NAME}`);
      unnamed = app.get<Queue>(`BullQueue_${UNNAMED_QUEUE_NAME}`);
    });

    afterAll(async () => {
      for (const each of [queue, unnamed]) {
        await each?.obliterate({ force: true }).catch(() => undefined);
        await each?.close().catch(() => undefined);
      }
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
      await post("/delayed", "bull-delayed-trace-1");

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "delayed-mail",
      );
      expect(job.traceId).toBe("bull-delayed-trace-1");
      expect(job.status).toBe("completed");
      expect(job.waitDuration).toBeLessThan(200);
    });

    it("keeps the inherited id on every attempt of a retried job", async () => {
      await post("/flaky", "bull-flaky-trace-1");

      await waitFor(
        () => runsOf("flaky-mail").length >= 3,
        5_000,
        "three attempts of flaky-mail",
      );
      const attempts = runsOf("flaky-mail");

      expect(attempts.map((attempt) => attempt.traceId)).toEqual([
        "bull-flaky-trace-1",
        "bull-flaky-trace-1",
        "bull-flaky-trace-1",
      ]);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        "failed",
        "failed",
        "completed",
      ]);
      expect(seenInside.map((seen) => seen.traceId)).toEqual([
        "bull-flaky-trace-1",
        "bull-flaky-trace-1",
        "bull-flaky-trace-1",
      ]);
    });

    it("passes the id down a chain of jobs", async () => {
      await post("/chain", "bull-chain-trace-1");

      const followUp = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "follow-up-mail",
      );
      expect(followUp.traceId).toBe("bull-chain-trace-1");
      expect(runsOf("first-mail")[0].traceId).toBe("bull-chain-trace-1");
    });

    it("leaves a repeatable job unstamped: every repetition mints its own id", async () => {
      await post("/repeat", "bull-repeat-trace-1");

      await waitFor(
        () => runsOf("repeating-mail").length >= 2,
        6_000,
        "two repetitions of repeating-mail",
      );
      const repetitions = runsOf("repeating-mail");

      for (const repetition of repetitions) {
        expect(repetition.traceId).toMatch(UUID);
        expect(repetition.traceId).not.toBe("bull-repeat-trace-1");
      }
      expect(
        new Set(repetitions.map((repetition) => repetition.traceId)).size,
      ).toBe(repetitions.length);
    });

    it("runs three jobs and their open request under one id at once, and keeps all four snapshots", async () => {
      await post("/fan-out", "bull-fan-out-trace-1");

      await waitFor(
        () => runsOf("slow-mail").length >= 3,
        5_000,
        "three slow-mail runs",
      );
      const http = await waitForSnapshot(
        requests,
        (item) => item.operationId === "/fan-out",
      );

      expect(http.traceId).toBe("bull-fan-out-trace-1");
      expect(http.traces[0]).toMatchObject({
        className: "CampaignController",
        methodKey: "fanOut",
      });
      for (const run of runsOf("slow-mail")) {
        expect(run.traceId).toBe("bull-fan-out-trace-1");
        expect(run.status).toBe("completed");
        expect(run.traces).toHaveLength(1);
      }
    });

    it("stamps an unnamed job, whether add() was given options or only data", async () => {
      await post("/unnamed", "bull-unnamed-trace-1");

      await waitFor(
        () => runsOf(UNNAMED_QUEUE_NAME).length >= 2,
        5_000,
        "both unnamed jobs",
      );
      const runs = runsOf(UNNAMED_QUEUE_NAME);

      expect(runs.map((run) => run.traceId)).toEqual([
        "bull-unnamed-trace-1",
        "bull-unnamed-trace-1",
      ]);
      // The options the application passed are still there beside the id.
      expect(
        runs.map((run) => run.maxAttempts).sort((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual([1, 2]);
    });
  },
);
