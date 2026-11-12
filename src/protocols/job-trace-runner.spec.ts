import { Logger } from "@nestjs/common";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { TRACE_CONTEXT_KEY, TRACE_REGISTRY_KEY } from "../observe.constants.js";
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

  const createRunner = (
    jobs: ObserveModuleOptionsWithDefaults["jobs"],
    enabled?: boolean,
  ) =>
    new JobTraceRunner(
      { insertJobSnapshot } as unknown as ObserveAgentSharedBuffer,
      {
        traceIdKey: TRACE_ID_KEY,
        jobs,
        enabled,
      } as ObserveModuleOptionsWithDefaults,
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

  it("still runs, without a trace, a job whose predicate throws", () => {
    const runner = createRunner({
      ignore: () => {
        throw new Error("bad predicate");
      },
    });

    const seen = runner.run(job, () => observeRun());

    expect(seen.traceId).toEqual(expect.any(String));
    expect(seen.traced).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad predicate"));
  });

  it("opens no trace for any job when the agent is disabled", async () => {
    // No `ignore` at all: `enabled: false` alone has to keep jobs out, as
    // jobs never pass through the sampler that keeps every other protocol out.
    const runner = createRunner(undefined, false);

    const seen = await runner.run(job, async () => observeRun());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(seen.traceId).toEqual(expect.any(String));
    expect(seen.traced).toBe(false);
    expect(insertJobSnapshot).not.toHaveBeenCalled();
  });
});

/**
 * Two layers of instrumentation around one run: a BullMQ Pro worker, patched
 * where it calls the processor, running a processor `@nestjs/bullmq` decorated
 * as well. The inner layer has to join the run the outer one opened.
 */
describe("JobTraceRunner: a run nested in its own job's run", () => {
  const TRACE_ID_KEY = "traceId";

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let registry: OperationTraceRegistry;
  let runner: JobTraceRunner<Record<string, unknown>>;

  const job = (id: string | number): JobRunDescriptor => ({
    queueName: "emails",
    name: "welcome",
    id,
    metadata: {},
  });

  const observeRun = () => {
    const store = als.getStore()!;
    return {
      traceId: store.get(TRACE_ID_KEY),
      registryKey: store.get(TRACE_REGISTRY_KEY) as string | undefined,
    };
  };

  beforeEach(() => {
    als = new AsyncLocalStorage();
    registry = new OperationTraceRegistry(als as never, false);
    runner = new JobTraceRunner(
      { insertJobSnapshot: vi.fn() } as unknown as ObserveAgentSharedBuffer,
      { traceIdKey: TRACE_ID_KEY } as ObserveModuleOptionsWithDefaults,
      registry,
      als as never,
      { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    );
  });

  it("runs inside the trace the outer layer opened, rather than hiding it", () => {
    const [outer, inner] = runner.run(job("7"), () => [
      observeRun(),
      runner.run(job("7"), () => observeRun()),
    ]);

    expect(inner).toEqual(outer);
    expect(registry.hasTrace(inner.registryKey!)).toBe(true);
  });

  it("recognises the job by queue and id, whatever type the id arrives as", () => {
    const [outer, inner] = runner.run(job(7), () => [
      observeRun(),
      runner.run(job("7"), () => observeRun()),
    ]);

    expect(inner).toEqual(outer);
  });

  it("runs a different job that starts in that context as a run of its own", () => {
    const [outer, inner] = runner.run(job("7"), () => [
      observeRun(),
      runner.run(job("8"), () => observeRun()),
    ]);

    expect(inner.traceId).toEqual(expect.any(String));
    expect(inner.traceId).not.toBe(outer.traceId);
    expect(inner.registryKey).not.toBe(outer.registryKey);
    expect(registry.hasTrace(inner.registryKey!)).toBe(true);
  });

  it("opens a run of its own in a store an operation left behind", () => {
    // `cron` re-arms a job's timer from the previous timer's callback, so a
    // job a request rescheduled fires in that request's store from then on.
    // Read as an operation still open around the run, the store sent every
    // firing into an id-less one: `TracerService.createSpan()` threw in the
    // handler, and no run was reported again.
    const stale = new Map<string, unknown>([
      [TRACE_ID_KEY, "answered-request"],
      [TRACE_REGISTRY_KEY, "answered-request-key"],
    ]);

    const seen = als.run(stale, () => runner.run(job("9"), () => observeRun()));

    expect(seen.traceId).toEqual(expect.any(String));
    expect(seen.traceId).not.toBe("answered-request");
    expect(registry.hasTrace(seen.registryKey!)).toBe(true);
  });
});

/**
 * What a handler returns goes back to its driver. Bull reads more off it than
 * its value - it calls `cancel()` on a promise-style processor's promise when
 * the job times out - and drops what a callback-style one returns, so a
 * promise of the runner's own making in its place either lost those members
 * or rejected where nothing listened.
 */
describe("JobTraceRunner: the promise a handler returns", () => {
  const TRACE_ID_KEY = "traceId";

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let endTrace: ReturnType<typeof vi.spyOn>;
  let runner: JobTraceRunner<Record<string, unknown>>;

  const job: JobRunDescriptor = {
    queueName: "clicks",
    name: "count",
    id: 1,
    metadata: {},
  };

  /** The status the run was ended with, once it is. */
  const reportedStatus = async () => {
    await vi.waitFor(() => expect(endTrace).toHaveBeenCalledOnce());
    return (endTrace.mock.calls[0][1] as { status?: string }).status;
  };

  beforeEach(() => {
    als = new AsyncLocalStorage();
    const registry = new OperationTraceRegistry(als as never, false);
    endTrace = vi.spyOn(registry, "endTrace");
    runner = new JobTraceRunner(
      { insertJobSnapshot: vi.fn() } as unknown as ObserveAgentSharedBuffer,
      { traceIdKey: TRACE_ID_KEY } as ObserveModuleOptionsWithDefaults,
      registry,
      als as never,
      { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    );
  });

  it("hands a promise-style handler's own promise back, members and all", async () => {
    const cancel = vi.fn();
    const work = Object.assign(Promise.resolve("rendered"), { cancel });

    const returned = runner.run(job, () => work);

    expect(returned).toBe(work);
    expect(returned.cancel).toBe(cancel);
    await expect(returned).resolves.toBe("rendered");
    expect(await reportedStatus()).toBe("completed");
  });

  it("still reports a promise-style run as failed when its promise rejects", async () => {
    const error = new Error("render failed");
    const work = Promise.reject(error);

    const returned = runner.run(job, () => work);

    expect(returned).toBe(work);
    await expect(returned).rejects.toBe(error);
    expect(await reportedStatus()).toBe("failed");
  });

  it("hands a callback-style handler's promise back as it returned it", async () => {
    // `(job, done) => redis.hincrby(key, field, n, done)`: ioredis reports the
    // failure to `done` and returns the promise it has handled that way, and
    // Bull drops what the processor returns.
    const work = Promise.reject(new Error("ERR value is not an integer"));

    const returned = runner.run(
      job,
      (settle) => {
        work.then(undefined, () => settle("failed"));
        return work;
      },
      true,
    );

    expect(returned).toBe(work);
    expect(await reportedStatus()).toBe("failed");
  });

  it("takes a callback-style run's outcome from its callback, not its promise", async () => {
    let done!: () => void;

    void runner.run(
      job,
      (settle) => {
        done = () => settle("failed");
        return Promise.resolve();
      },
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    done();

    expect(await reportedStatus()).toBe("failed");
  });

  it("does not leave a dropped promise rejecting once its failure was reported", async () => {
    // An instrumented provider's `@Process() count(job, done)` hands back a
    // promise chained onto its method's: the method's own was handled, the
    // chained one rejects as well, and Bull drops it.
    let report!: () => void;
    const chained = new Promise((_, reject) => {
      report = () => reject(new Error("ERR value is not an integer"));
    });

    void runner.run(
      job,
      (settle) => {
        queueMicrotask(() => {
          settle("failed");
          report();
        });
        return chained;
      },
      true,
    );

    expect(await reportedStatus()).toBe("failed");
    // Vitest fails the file on a rejection nothing handled.
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});

describe("JobTraceRunner: patchEnqueue", () => {
  const TRACE_ID_KEY = "traceId";

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let runner: JobTraceRunner<Record<string, unknown>>;

  beforeEach(() => {
    als = new AsyncLocalStorage();
    runner = new JobTraceRunner(
      {} as ObserveAgentSharedBuffer,
      { traceIdKey: TRACE_ID_KEY } as ObserveModuleOptionsWithDefaults,
      {} as OperationTraceRegistry,
      als as never,
      { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    );
  });

  const inTrace = <T>(fn: () => T) =>
    als.run(new Map([[TRACE_ID_KEY, "trace-1"]]), fn);

  it("wraps a subclass's own add, not the original its parent parked", () => {
    const baseAdd = vi.fn();
    const proAdd = vi.fn();
    class Queue {
      add(...args: unknown[]) {
        return baseAdd(...args);
      }
    }
    // Overrides `add` without calling `super.add`, as `QueuePro` may.
    class QueuePro extends Queue {
      override add(...args: unknown[]) {
        return proAdd(...args);
      }
    }
    runner.patchEnqueue(Queue.prototype as never, () => 2);
    runner.patchEnqueue(QueuePro.prototype as never, () => 2);

    inTrace(() => new QueuePro().add("welcome", {}, { attempts: 3 }));

    expect(baseAdd).not.toHaveBeenCalled();
    expect(proAdd).toHaveBeenCalledWith(
      "welcome",
      {},
      { attempts: 3, observeTraceId: "trace-1" },
    );
  });

  it("stamps once when a subclass's add goes through super.add", () => {
    const baseAdd = vi.fn();
    class Queue {
      add(...args: unknown[]) {
        return baseAdd(...args);
      }
    }
    class QueuePro extends Queue {
      override add(...args: unknown[]) {
        return super.add(...args);
      }
    }
    runner.patchEnqueue(Queue.prototype as never, () => 2);
    runner.patchEnqueue(QueuePro.prototype as never, () => 2);

    inTrace(() => new QueuePro().add("welcome", {}));

    expect(baseAdd).toHaveBeenCalledOnce();
    expect(baseAdd).toHaveBeenCalledWith(
      "welcome",
      {},
      { observeTraceId: "trace-1" },
    );
  });

  it("replaces its own wrapper when patched again, rather than nesting it", () => {
    const add = vi.fn();
    class Queue {
      add(...args: unknown[]) {
        return add(...args);
      }
    }
    runner.patchEnqueue(Queue.prototype as never, () => 2);
    runner.patchEnqueue(Queue.prototype as never, () => 2);

    inTrace(() => new Queue().add("welcome", {}));

    expect(add).toHaveBeenCalledOnce();
  });
});

/**
 * With `openTelemetry` on, a job carries W3C trace context beside the trace id
 * it inherits, and runs in it for an OpenTelemetry SDK in the worker's
 * process. With the option off - or the agent not reporting to NestJS
 * Observe - nothing changes: the options carry the id alone, and the job runs
 * in no OpenTelemetry trace.
 */
describe("JobTraceRunner: W3C trace context, with openTelemetry on", () => {
  const TRACE_ID_KEY = "traceId";
  // The W3C spec's own example, and the id Observe writes it as.
  const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
  const TRACE_ID_AS_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
  const SPAN_ID = "00f067aa0ba902b7";
  const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let registry: OperationTraceRegistry;

  const createRunner = (
    openTelemetry: boolean | undefined,
    reporting = true,
    jobs?: ObserveModuleOptionsWithDefaults["jobs"],
  ) =>
    new JobTraceRunner(
      {
        insertJobSnapshot: vi.fn(),
        isReporting: () => reporting,
      } as unknown as ObserveAgentSharedBuffer,
      {
        traceIdKey: TRACE_ID_KEY,
        openTelemetry,
        jobs,
      } as ObserveModuleOptionsWithDefaults,
      registry,
      als as never,
      { warn: vi.fn(), debug: vi.fn() } as unknown as Logger,
    );

  beforeEach(() => {
    als = new AsyncLocalStorage();
    registry = new OperationTraceRegistry(als as never, false);
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
  });

  afterEach(() => {
    context.disable();
  });

  /** The options a job enqueued in an operation with `TRACE_ID_AS_UUID` gets. */
  const enqueued = (runner: JobTraceRunner<Record<string, unknown>>) => {
    const add = vi.fn();
    class Queue {
      add(...args: unknown[]) {
        return add(...args);
      }
    }
    runner.patchEnqueue(Queue.prototype as never, () => 2);
    als.run(new Map([[TRACE_ID_KEY, TRACE_ID_AS_UUID]]), () =>
      new Queue().add("welcome", {}, { attempts: 3 }),
    );
    return add.mock.calls[0]?.[2] as Record<string, unknown>;
  };

  /** The OpenTelemetry span context a job enqueued with `opts` runs in. */
  const ranIn = (
    runner: JobTraceRunner<Record<string, unknown>>,
    opts: Record<string, unknown>,
  ) =>
    runner.run(
      { queueName: "emails", name: "welcome", id: 1, opts, metadata: {} },
      () => trace.getSpanContext(context.active()),
    );

  it("stamps a traceparent in the job's trace beside its trace id", () => {
    expect(enqueued(createRunner(true))).toEqual({
      attempts: 3,
      observeTraceId: TRACE_ID_AS_UUID,
      observeTraceparent: expect.stringMatching(
        new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-0[01]$`),
      ),
    });
  });

  it.each([
    ["off", undefined, true],
    ["on while the agent is not reporting", true, false],
  ])(
    "stamps the trace id alone with openTelemetry %s",
    (_, openTelemetry, reporting) => {
      expect(enqueued(createRunner(openTelemetry, reporting))).toEqual({
        attempts: 3,
        observeTraceId: TRACE_ID_AS_UUID,
      });
    },
  );

  it("runs the job in the trace it was enqueued in", () => {
    expect(
      ranIn(createRunner(true), {
        observeTraceId: TRACE_ID_AS_UUID,
        observeTraceparent: TRACEPARENT,
      }),
    ).toEqual({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
      isRemote: true,
    });
  });

  it("runs a job jobs.ignore matches in that trace too", () => {
    const runner = createRunner(true, true, { ignore: () => true });

    expect(
      ranIn(runner, {
        observeTraceId: TRACE_ID_AS_UUID,
        observeTraceparent: TRACEPARENT,
      })?.traceId,
    ).toBe(TRACE_ID);
  });

  it.each([
    ["off", undefined, true],
    ["on while the agent is not reporting", true, false],
  ])(
    "runs the job in no trace with openTelemetry %s",
    (_, openTelemetry, reporting) => {
      expect(
        ranIn(createRunner(openTelemetry, reporting), {
          observeTraceId: TRACE_ID_AS_UUID,
          observeTraceparent: TRACEPARENT,
        }),
      ).toBeUndefined();
    },
  );

  it("runs a job that inherited no trace id in no trace", () => {
    expect(
      ranIn(createRunner(true), { observeTraceparent: TRACEPARENT }),
    ).toBeUndefined();
  });

  /** The context a job's store carries, and the one its trace started with. */
  const recordedFor = (opts: Record<string, unknown>) => {
    const startTrace = vi.spyOn(registry, "startTrace");
    const stored = createRunner(true).run(
      { queueName: "emails", name: "welcome", id: 1, opts, metadata: {} },
      () => als.getStore()?.get(TRACE_CONTEXT_KEY),
    );
    return { stored, started: startTrace.mock.calls[0]?.[3] };
  };

  it("puts the job's span under the span that enqueued it, and carries that context in its store", () => {
    const sentIn = { traceId: TRACE_ID, parentSpanId: SPAN_ID, sampled: true };

    expect(
      recordedFor({
        observeTraceId: TRACE_ID_AS_UUID,
        observeTraceparent: TRACEPARENT,
      }),
    ).toEqual({ stored: sentIn, started: sentIn });
  });

  it("records no context for a job enqueued unsampled, by an operation the agent was not recording", () => {
    expect(
      recordedFor({
        observeTraceId: TRACE_ID_AS_UUID,
        observeTraceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
      }),
    ).toEqual({ stored: undefined, started: undefined });
  });
});
