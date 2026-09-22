import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { JobRunDescriptor, JobTraceRunner } from "./job-trace-runner.js";

/**
 * `jobs.ignore` decides, per run, whether a queue job is traced at all. An
 * ignored run must still execute - and under a trace id, so its logs
 * correlate - but open no trace and ship nothing.
 */
describe("JobTraceRunner: jobs.ignore", () => {
  const job: JobRunDescriptor = {
    queueName: "emails",
    name: "send-welcome",
    id: 42,
    metadata: {},
  };

  const createRunner = (jobs: Record<string, unknown>) => {
    const registry = {
      startTrace: vi.fn(),
      endTrace: vi.fn(),
      pluckSnapshot: vi.fn(async () => undefined),
    };
    const buffer = { insertJobSnapshot: vi.fn() };
    const als = new AsyncLocalStorage<Map<string, any>>();
    const runner = new JobTraceRunner(
      buffer as never,
      { traceIdKey: "traceId", jobs } as never,
      registry as never,
      als,
      new Logger("test"),
    );
    return { runner, registry, buffer, als };
  };

  it("runs an ignored job without opening a trace", async () => {
    const ignore = vi.fn(() => true);
    const { runner, registry, buffer, als } = createRunner({ ignore });

    const result = runner.run(job, () => {
      const store = als.getStore();
      return {
        traceId: store?.get("traceId"),
        registryKey: store?.get(TRACE_REGISTRY_KEY),
      };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ignore).toHaveBeenCalledWith({
      queueName: "emails",
      name: "send-welcome",
      id: "42",
    });
    expect(result.traceId).toEqual(expect.any(String));
    // Spans resolve the registry key first; it must be set so they cannot fall
    // through to an inherited trace id and join the trace that owns it.
    expect(result.registryKey).toEqual(expect.any(String));
    expect(registry.startTrace).not.toHaveBeenCalled();
    expect(registry.endTrace).not.toHaveBeenCalled();
    expect(buffer.insertJobSnapshot).not.toHaveBeenCalled();
  });

  it("traces a job the predicate does not match", () => {
    const { runner, registry } = createRunner({ ignore: () => false });

    runner.run(job, () => "done");

    expect(registry.startTrace).toHaveBeenCalledTimes(1);
    expect(registry.startTrace.mock.calls[0][1]).toMatchObject({
      queueName: "emails",
      name: "send-welcome",
      id: "42",
    });
  });

  it("still settles a callback-driven job that is ignored", () => {
    const { runner, registry } = createRunner({ ignore: () => true });

    const settleCalls: unknown[] = [];
    runner.run(
      job,
      (settle) => {
        settleCalls.push(settle("completed"));
        return undefined;
      },
      true,
    );

    expect(settleCalls).toEqual([undefined]);
    expect(registry.endTrace).not.toHaveBeenCalled();
  });
});
