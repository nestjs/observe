import { BullModule, InjectQueue, Process, Processor } from "@nestjs/bull";
import { Controller, Injectable, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Job, Queue } from "bull";
import { connect } from "net";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
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

const QUEUE_NAME = `observe-bull-int-${process.pid}`;

const { ObserveModule, ObserveInstrument } = createObserveModule();

/** How many times the processor `jobs.ignore` matches has run. */
let ignoredRuns = 0;

@Injectable()
class MailerService {
  deliver() {
    return "delivered";
  }
}

@Processor(QUEUE_NAME)
class MailProcessor {
  constructor(private readonly mailer: MailerService) {}

  @Process("welcome-mail")
  async welcome(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("bulk-mail")
  async bulk(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("orphan-mail")
  async orphan(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("ignored-mail")
  async ignored(_job: Job) {
    ignoredRuns++;
    return this.mailer.deliver();
  }

  @Process("after-ignored-mail")
  async afterIgnored(_job: Job) {
    return this.mailer.deliver();
  }

  @Process("failing-mail")
  async failing(_job: Job) {
    throw new Error("deliberate");
  }

  // Two parameters: Bull reads the arity and waits for `done`, not a promise.
  @Process("callback-mail")
  callback(_job: Job, done: (error?: Error | null) => void) {
    setTimeout(() => done(), 5);
  }
}

@Controller()
class SignupController {
  constructor(@InjectQueue(QUEUE_NAME) private readonly queue: Queue) {}

  @Post("signup")
  async signup() {
    await this.queue.add("welcome-mail", {});
    // Long enough for the worker - in this same process - to start the job
    // while the request that enqueued it is still open under the same id.
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { ok: true };
  }

  @Post("bulk")
  async bulk() {
    await this.queue.addBulk([{ name: "bulk-mail", data: {} }]);
    return { ok: true };
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      redis: { host: REDIS_HOST, port: REDIS_PORT },
    }),
    BullModule.registerQueue({ name: QUEUE_NAME }),
    ObserveModule.forRoot(
      testObserveOptions({
        jobs: { ignore: (job) => job.name === "ignored-mail" },
      }),
    ),
  ],
  controllers: [SignupController],
  providers: [MailerService, MailProcessor],
})
class QueueTestModule {}

/**
 * Job collection for the original Bull behind `@nestjs/bull`, end to end
 * through a real queue: the handler patch has to land before the explorer
 * registers processors in `onModuleInit`, and the inherited trace id has to
 * survive the trip through Redis in the job's options.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: @nestjs/bull collection",
  () => {
    let app: NestExpressApplication;
    let requests: CollectedSnapshots;
    let jobs: CollectedJobSnapshots;
    let queue: Queue;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(QueueTestModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      requests = collectSnapshots(app);
      jobs = collectJobSnapshots(app);
      await app.init();
      queue = app.get<Queue>(`BullQueue_${QUEUE_NAME}`);
    });

    afterAll(async () => {
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await queue?.close().catch(() => undefined);
      await app?.close();
    });

    it("runs the job under the enqueuing request's trace id, and keeps both snapshots", async () => {
      await request(app.getHttpServer())
        .post("/signup")
        .set("x-request-id", "signup-trace-1")
        .expect(201);

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "welcome-mail",
      );
      expect(job.traceId).toBe("signup-trace-1");
      expect(job.status).toBe("completed");
      expect(job.queueName).toBe(QUEUE_NAME);
      expect(job.waitDuration).toEqual(expect.any(Number));
      expect(job.traces[0]).toMatchObject({
        className: "MailProcessor",
        methodKey: "welcome",
      });

      const http = await waitForSnapshot(
        requests,
        (item) => item.operationId === "/signup",
      );
      expect(http.traceId).toBe("signup-trace-1");
      expect(http.traces[0]).toMatchObject({
        className: "SignupController",
        methodKey: "signup",
      });
    });

    it("inherits through addBulk as well", async () => {
      await request(app.getHttpServer())
        .post("/bulk")
        .set("x-request-id", "bulk-trace-1")
        .expect(201);

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "bulk-mail",
      );
      expect(job.traceId).toBe("bulk-trace-1");
    });

    it("mints a fresh id for a job enqueued outside any trace", async () => {
      await queue.add("orphan-mail", {});

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "orphan-mail",
      );
      expect(job.traceId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("runs a job matched by jobs.ignore without reporting it", async () => {
      await queue.add("ignored-mail", {});
      await waitFor(() => ignoredRuns === 1, 5_000, "the ignored-mail run");

      // Enqueued once the ignored run is under way: had it a snapshot, it would
      // land well before this job has made the round trip through Redis.
      await queue.add("after-ignored-mail", {});
      await waitForJobSnapshot(
        jobs,
        (item) => item.name === "after-ignored-mail",
      );
      expect(jobs.items.map((item) => item.name)).not.toContain("ignored-mail");
    });

    it("reports a throwing processor as failed", async () => {
      await queue.add("failing-mail", {});

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "failing-mail",
      );
      expect(job.status).toBe("failed");
    });

    it("waits for `done` on a callback-style processor", async () => {
      await queue.add("callback-mail", {});

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "callback-mail",
      );
      expect(job.status).toBe("completed");
      expect(job.duration).toBeGreaterThanOrEqual(4);
    });
  },
);
