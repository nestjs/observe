import { INestApplicationContext, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { validateTelemetryPayload } from "../agent/telemetry-wire-contract.js";
import { JobSnapshotEncoder } from "../encoders/job-snapshot.encoder.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedJobSnapshots,
  collectJobSnapshots,
  testObserveOptions,
  waitFor,
  waitForJobSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class LedgerService {
  async reconcile() {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return "reconciled";
  }
}

@Injectable()
class OrdersConsumer {
  constructor(
    private readonly ledger: LedgerService,
    private readonly tracer: TracerService,
  ) {}

  handle(message: { key: string; traceId?: string }) {
    return this.tracer.runJob(
      {
        queueName: "kafka",
        name: "orders.created",
        id: message.key,
        traceId: message.traceId,
      },
      () => this.ledger.reconcile(),
    );
  }

  fail() {
    return this.tracer.runJob(
      { queueName: "kafka", name: "orders.rejected" },
      async () => {
        await this.ledger.reconcile();
        throw new Error("deliberate");
      },
    );
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({ jobs: { tags: { environment: "test" } } }),
    ),
  ],
  providers: [LedgerService, OrdersConsumer],
})
class ManualJobTestModule {}

/**
 * `TracerService.runJob`, end to end through a standalone application
 * context, where no request, queue driver or scheduler opens a trace for it.
 */
describe("ObserveModule: TracerService.runJob", () => {
  let app: INestApplicationContext;
  let collected: CollectedJobSnapshots;
  let consumer: OrdersConsumer;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(ManualJobTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectJobSnapshots(app);
    consumer = app.get(OrdersConsumer);
  });

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    collected.clear();
  });

  it("reports a run as a completed job, with the providers it called nested under it", async () => {
    await expect(consumer.handle({ key: "offset-1" })).resolves.toBe(
      "reconciled",
    );

    const snapshot = await waitForJobSnapshot(
      collected,
      (item) => item.id === "offset-1",
    );
    expect(snapshot).toMatchObject({
      queueName: "kafka",
      name: "orders.created",
      status: "completed",
      traceId: expect.any(String),
      tags: { environment: "test" },
    });
    expect(snapshot.traces).toHaveLength(1);
    const [root] = snapshot.traces;
    expect(root).toMatchObject({
      name: "orders.created",
      origin: "manual",
      className: "kafka",
      methodKey: "orders.created",
    });
    expect(root.children).toEqual([
      expect.objectContaining({
        className: "LedgerService",
        methodKey: "reconcile",
      }),
    ]);
  });

  it("reports a failing run as failed and re-throws its error", async () => {
    await expect(consumer.fail()).rejects.toThrow("deliberate");

    const snapshot = await waitForJobSnapshot(
      collected,
      (item) => item.name === "orders.rejected",
    );
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toMatchObject({ message: "deliberate" });
  });

  it("reports concurrent runs sharing an inherited trace id as one job each", async () => {
    const runs = 200;
    await Promise.all(
      Array.from({ length: runs }, (_, i) =>
        consumer.handle({ key: `offset-${i}`, traceId: "producer-trace" }),
      ),
    );

    await waitFor(
      () => collected.items.length === runs,
      5000,
      `${runs} job snapshots`,
    );
    expect(new Set(collected.items.map((item) => item.id)).size).toBe(runs);
    for (const snapshot of collected.items) {
      expect(snapshot.traceId).toBe("producer-trace");
      // Each run's spans stay in its own tree, however the runs interleave.
      expect(snapshot.traces).toHaveLength(1);
      expect(snapshot.traces[0].children).toEqual([
        expect.objectContaining({ methodKey: "reconcile" }),
      ]);
    }

    expect(
      validateTelemetryPayload(
        {
          serviceId: "svc",
          jobs: collected.items.map((item) => JobSnapshotEncoder.encode(item)),
        },
        { forbidUnknown: true },
      ),
    ).toEqual([]);
  });
});
