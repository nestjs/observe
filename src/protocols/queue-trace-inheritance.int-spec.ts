import { InjectQueue, BullModule, Processor, WorkerHost } from "@nestjs/bullmq";
import { Controller, Injectable, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import type { Job, Queue } from "bullmq";
import { connect } from "net";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedJobSnapshots,
  CollectedSnapshots,
  collectJobSnapshots,
  collectSnapshots,
  testObserveOptions,
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

const QUEUE_NAME = `observe-int-${process.pid}`;

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class MailerService {
  deliver() {
    return "delivered";
  }
}

@Processor(QUEUE_NAME)
class MailProcessor extends WorkerHost {
  constructor(private readonly mailer: MailerService) {
    super();
  }

  async process(_job: Job) {
    return this.mailer.deliver();
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
      connection: { host: REDIS_HOST, port: REDIS_PORT },
    }),
    BullModule.registerQueue({ name: QUEUE_NAME }),
    ObserveModule.forRoot(testObserveOptions()),
  ],
  controllers: [SignupController],
  providers: [MailerService, MailProcessor],
})
class QueueTestModule {}

/**
 * A job reports under the trace of the operation that enqueued it.
 *
 * The id has to cross Redis to get from `queue.add()` to the worker, so only
 * a real queue proves both halves: that the option is stamped and survives
 * BullMQ's option encoding, and that a run sharing an id with a request still
 * open in the same process leaves that request's snapshot intact.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: BullMQ trace inheritance",
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
      expect(job.traces[0]).toMatchObject({
        className: "MailProcessor",
        methodKey: "process",
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

    it("ignores a stamped id that is not a plausible trace id", async () => {
      await queue.add("forged-mail", {}, {
        observeTraceId: "x".repeat(500),
      } as never);

      const job = await waitForJobSnapshot(
        jobs,
        (item) => item.name === "forged-mail",
      );
      expect(job.traceId).toMatch(/^[0-9a-f-]{36}$/);
    });
  },
);
