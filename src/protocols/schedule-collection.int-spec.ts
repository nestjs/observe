import { INestApplication, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Cron, Interval, ScheduleModule, Timeout } from "@nestjs/schedule";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedJobSnapshots,
  collectJobSnapshots,
  testObserveOptions,
  waitForJobSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class LedgerService {
  reconcile() {
    return "reconciled";
  }
}

@Injectable()
class TasksService {
  constructor(private readonly ledger: LedgerService) {}

  @Timeout(20)
  async nightlyReport() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return this.ledger.reconcile();
  }

  @Timeout("explode", 20)
  async explode() {
    await Promise.resolve();
    throw new Error("deliberate");
  }

  @Interval("heartbeat", 50)
  heartbeat() {
    return "ok";
  }

  @Cron("* * * * * *", { name: "every-second" })
  everySecond() {
    return "tick";
  }

  ignoredRuns = 0;

  @Timeout("ignored-report", 20)
  ignoredReport() {
    this.ignoredRuns++;
    return this.ledger.reconcile();
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObserveModule.forRoot(
      testObserveOptions({
        jobs: {
          tags: { environment: "test" },
          ignore: (job) => job.name === "ignored-report",
          setAttributes: (job) => ({ jobName: job.name, jobId: job.id! }),
        },
      }),
    ),
  ],
  providers: [LedgerService, TasksService],
})
class ScheduleTestModule {}

/**
 * Scheduled job collection, end to end through a real Nest app running
 * `@nestjs/schedule`.
 *
 * The agent patches `ScheduleExplorer.prototype.wrapFunctionInTryCatchBlocks`
 * from its constructor, and the explorer wraps every handler in
 * `onModuleInit` - so the only thing that proves the patch lands in time is a
 * real application going through Nest's full bootstrap sequence.
 */
describe("ObserveModule: @nestjs/schedule collection", () => {
  let app: INestApplication;
  let collected: CollectedJobSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create(ScheduleTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectJobSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("reports a @Timeout handler as a completed job with its spans", async () => {
    const snapshot = await waitForJobSnapshot(
      collected,
      (item) => item.name === "TasksService.nightlyReport",
    );

    expect(snapshot.queueName).toBe("timeout");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.id).toEqual(expect.any(String));
    expect(snapshot.duration).toBeGreaterThan(0);
    expect(snapshot.calledAt).toEqual(expect.any(String));
    expect(snapshot.tags).toEqual({ environment: "test" });

    // The handler itself is the root span, and the provider it called into is
    // nested under it - the instance decorator saw the whole run.
    expect(snapshot.traces).toHaveLength(1);
    const [root] = snapshot.traces;
    expect(root).toMatchObject({
      className: "TasksService",
      methodKey: "nightlyReport",
    });
    expect(root.children).toEqual([
      expect.objectContaining({
        className: "LedgerService",
        methodKey: "reconcile",
      }),
    ]);
  });

  it("reports a throwing handler as failed, with the error, without crashing the scheduler", async () => {
    const snapshot = await waitForJobSnapshot(
      collected,
      (item) => item.name === "explode",
    );

    expect(snapshot.queueName).toBe("timeout");
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toMatchObject({ message: "deliberate" });
  });

  it("reports an @Interval handler under its explicit name on every firing", async () => {
    await waitForJobSnapshot(
      collected,
      (item) =>
        collected.items.filter((s) => s.name === "heartbeat").length >= 2 &&
        item.name === "heartbeat",
    );

    const firings = collected.items.filter((s) => s.name === "heartbeat");
    expect(firings.length).toBeGreaterThanOrEqual(2);
    for (const firing of firings) {
      expect(firing.queueName).toBe("interval");
      expect(firing.status).toBe("completed");
    }
    // Each firing is its own job run, with its own id and trace.
    expect(new Set(firings.map((s) => s.id)).size).toBe(firings.length);
    expect(new Set(firings.map((s) => s.traceId)).size).toBe(firings.length);
  });

  it("reports a @Cron handler under the cron job's name", async () => {
    const snapshot = await waitForJobSnapshot(
      collected,
      (item) => item.name === "every-second",
      5000,
    );

    expect(snapshot.queueName).toBe("cron");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.traces[0]).toMatchObject({
      className: "TasksService",
      methodKey: "everySecond",
    });
  });

  it("runs a handler matched by jobs.ignore without reporting it", async () => {
    // Fires alongside nightlyReport, so once that one has shipped the ignored
    // one has had every chance to.
    await waitForJobSnapshot(
      collected,
      (item) => item.name === "TasksService.nightlyReport",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.get(TasksService).ignoredRuns).toBe(1);
    expect(
      collected.items.filter((s) => s.name === "ignored-report"),
    ).toHaveLength(0);
  });
});

@Injectable()
class PlainTasksService {
  @Timeout(20)
  tick() {
    return "tick";
  }
}

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ObserveModule.forRoot(testObserveOptions()),
  ],
  providers: [PlainTasksService],
})
class UninstrumentedScheduleModule {}

describe("ObserveModule: @nestjs/schedule collection without the instrument option", () => {
  let app: INestApplication;
  let collected: CollectedJobSnapshots;

  beforeAll(async () => {
    // No `instrument`: the handler runs, but nothing records a span for it.
    app = await NestFactory.create(UninstrumentedScheduleModule, {
      logger: false,
    });
    collected = collectJobSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("drops the span-less trace rather than shipping an empty job", async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(collected.items).toHaveLength(0);
  });
});
