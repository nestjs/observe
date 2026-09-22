import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { JobRunDescriptor, JobTraceRunner } from "./job-trace-runner.js";

/**
 * `jobs.ignore`, below every driver: BullMQ, Bull and `@nestjs/schedule` all
 * start their runs here, so this is the one place the option is decided - and
 * the queue drivers' own suites need a Redis this one does not.
 */
describe("JobTraceRunner: jobs.ignore", () => {
  const TRACE_ID_KEY = "traceId";

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let registry: OperationTraceRegistry;
  let insertJobSnapshot: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  const createRunner = (jobs: ObserveModuleOptionsWithDefaults["jobs"]) =>
    new JobTraceRunner(
      { insertJobSnapshot } as unknown as ObserveAgentSharedBuffer,
      { traceIdKey: TRACE_ID_KEY, jobs } as ObserveModuleOptionsWithDefaults,
      registry,
      als as never,
      { warn, debug: vi.fn() } as unknown as Logger,
    );

  const job: JobRunDescriptor = {
    queueName: "emails",
    name: "heartbeat",
    id: 42,
    metadata: {},
  };

  /** What the handler saw of its own run. */
  const observeRun = () => {
    const store = als.getStore()!;
    const registryKey = store.get(TRACE_REGISTRY_KEY) as string;
    return {
      traceId: store.get(TRACE_ID_KEY),
      traced: registry.hasTrace(registryKey),
    };
  };

  beforeEach(() => {
    als = new AsyncLocalStorage();
    registry = new OperationTraceRegistry(als as never, false);
    insertJobSnapshot = vi.fn();
    warn = vi.fn();
  });

  it("runs a matched job under a trace id of its own without opening a trace", async () => {
    const runner = createRunner({ ignore: (run) => run.name === "heartbeat" });

    const seen = await runner.run(job, async () => observeRun());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(seen.traceId).toEqual(expect.any(String));
    expect(seen.traced).toBe(false);
    expect(insertJobSnapshot).not.toHaveBeenCalled();
  });

  it("traces a job the predicate does not match", () => {
    const runner = createRunner({ ignore: (run) => run.name === "other" });

    expect(runner.run(job, () => observeRun()).traced).toBe(true);
  });

  it("hands the predicate the id as a string, as setAttributes gets it", () => {
    const ignore = vi.fn(() => true);
    createRunner({ ignore }).run(job, () => undefined);

    expect(ignore).toHaveBeenCalledWith({
      queueName: "emails",
      name: "heartbeat",
      id: "42",
    });
  });

  it("leaves a callback-style handler to finish through its own callback", () => {
    const runner = createRunner({ ignore: () => true });
    const done = vi.fn();

    runner.run(
      job,
      (settle) => {
        settle("completed");
        done();
      },
      true,
    );

    expect(done).toHaveBeenCalledOnce();
  });

  it("still runs, and traces, a job whose predicate throws", () => {
    const runner = createRunner({
      ignore: () => {
        throw new Error("bad predicate");
      },
    });

    const seen = runner.run(job, () => observeRun());

    expect(seen.traced).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad predicate"));
  });
});
