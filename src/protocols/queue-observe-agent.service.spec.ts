import { Logger } from "@nestjs/common";
import { ProcessorDecoratorService } from "@nestjs/bullmq";
import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { QueueObserveAgentService } from "./queue-observe-agent.service.js";

const prototype = ProcessorDecoratorService.prototype as {
  decorate?: unknown;
};
const originalDecorate = prototype.decorate;

const createAgent = () =>
  new QueueObserveAgentService(
    {} as never,
    { traceIdKey: "traceId" } as never,
    {} as never,
    new AsyncLocalStorage<Map<string, any>>(),
  );

/** An agent whose runner can open and close a trace for real. */
const createTracingAgent = () => {
  const als = new AsyncLocalStorage<Map<string, any>>();
  return new QueueObserveAgentService(
    { insertJobSnapshot: vi.fn() } as never,
    { traceIdKey: "traceId" } as never,
    new OperationTraceRegistry(als as never, false),
    als,
  );
};

/** A method read off a prototype as a plain value, to compare identities. */
const methodOf = (target: object, name: string) =>
  (target as Record<string, unknown>)[name];

afterEach(() => {
  prototype.decorate = originalDecorate;
  vi.restoreAllMocks();
});

/**
 * `@nestjs/bullmq` is an optional peer: the agent must patch the processor
 * decorator when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("QueueObserveAgentService", () => {
  it("patches the processor decorator when @nestjs/bullmq is installed", () => {
    createAgent();

    expect(prototype.decorate).toEqual(expect.any(Function));
    expect(prototype.decorate).not.toBe(originalDecorate);
  });

  it("stays inert when @nestjs/bullmq is not installed", () => {
    vi.spyOn(
      QueueObserveAgentService.prototype as unknown as {
        loadProcessorDecoratorService: () => unknown;
      },
      "loadProcessorDecoratorService",
    ).mockReturnValue(undefined);

    expect(() => createAgent()).not.toThrow();
    expect(prototype.decorate).toBe(originalDecorate);
  });

  it("hands the processor the lock token and abort signal the worker passed", async () => {
    createTracingAgent();
    const processor = vi.fn(async () => "done");
    const signal = new AbortController().signal;

    const decorated = (
      prototype.decorate as (
        processor: unknown,
      ) => (...args: unknown[]) => Promise<unknown>
    )(processor);
    const job = { queueName: "emails", name: "welcome", id: "1" };
    await decorated(job, "lock-token", signal);

    expect(processor).toHaveBeenCalledWith(job, "lock-token", signal);
  });

  it.each([
    ["a timestamp past what a Date holds", { timestamp: 8.64e15 + 1 }],
    ["a timestamp that is no number", { timestamp: Number.NaN }],
    [
      "a delay option that is an object",
      // What BullMQ hands back for options written straight to Redis.
      {
        timestamp: 1_700_000_000_000,
        delay: 0,
        opts: { delay: JSON.parse('{"toString":1}') },
      },
    ],
  ])("still runs a job with %s", async (_, fields) => {
    // Formatting the job's times threw before the processor was called, and
    // the worker failed a job that completes without the agent.
    createTracingAgent();
    const processor = vi.fn(async () => "done");
    const decorated = (
      prototype.decorate as (
        processor: unknown,
      ) => (...args: unknown[]) => Promise<unknown>
    )(processor);

    await expect(
      decorated({ queueName: "emails", name: "welcome", id: "1", ...fields }),
    ).resolves.toBe("done");
    expect(processor).toHaveBeenCalledOnce();
  });

  it("declares the parameters of the processor it stands in for", () => {
    // BullMQ's worker builds an abort signal for a job - and `cancelJob()`
    // has something to abort - only for a processor that declares three
    // parameters, and `@nestjs/bullmq` hands it the decorated one.
    createAgent();
    const decorate = prototype.decorate as (processor: unknown) => {
      length: number;
    };
    class ExportProcessor {
      process(_job: unknown, _token?: string, _signal?: AbortSignal) {
        return Promise.resolve();
      }
    }
    const instance = new ExportProcessor();

    expect(decorate(instance.process.bind(instance)).length).toBe(3);
    expect(decorate((_job: unknown) => undefined).length).toBe(1);
  });

  /**
   * `decorate` is documented as the method to override, and an application
   * reaches it as the agent does, on the prototype. The agent used to put its
   * own in place of whatever was there.
   */
  describe("an override of decorate the application installed", () => {
    type Processor = (...args: unknown[]) => unknown;
    type Override = (this: unknown, processor: Processor) => unknown;
    const job = { queueName: "emails", name: "welcome", id: "1" };
    /** Decorates as the explorer does: on its own instance of the service. */
    const decorateOn = (instance: object, processor: Processor) =>
      (prototype.decorate as Override).call(instance, processor) as (
        ...args: unknown[]
      ) => Promise<unknown>;
    const decorateWith = (processor: Processor) =>
      decorateOn(new ProcessorDecoratorService(), processor);

    it("is still called, on the explorer's instance, and the job traced around what it returns", async () => {
      const receivers: unknown[] = [];
      prototype.decorate = function (this: unknown, processor: Processor) {
        receivers.push(this);
        return (...args: unknown[]) => processor(...args);
      } satisfies Override;
      createTracingAgent();
      const instance = new ProcessorDecoratorService();
      const processor = vi.fn(async () => "done");

      await expect(
        decorateOn(instance, processor)(job, "lock-token"),
      ).resolves.toBe("done");

      expect(receivers).toEqual([instance]);
      expect(processor).toHaveBeenCalledWith(job, "lock-token");
    });

    it("still refuses a job it refuses", async () => {
      prototype.decorate = (() => async () => {
        throw new Error("job refused");
      }) satisfies Override;
      createTracingAgent();
      const processor = vi.fn();

      await expect(decorateWith(processor)(job)).rejects.toThrow("job refused");
      expect(processor).not.toHaveBeenCalled();
    });

    it("declares the parameters of the function the override returns", () => {
      prototype.decorate = (() =>
        (_job: unknown, _token?: string, _signal?: AbortSignal) =>
          undefined) satisfies Override;
      createAgent();

      expect(decorateWith(() => undefined).length).toBe(3);
    });

    it("is wrapped once by a second agent, which sees through the first one's wrapper", async () => {
      const override = vi.fn((processor: Processor) => processor);
      prototype.decorate = override;
      createTracingAgent();
      createTracingAgent();

      await decorateWith(vi.fn(async () => "done"))(job);

      expect(override).toHaveBeenCalledOnce();
    });

    it("is kept when installed after an agent, by the next agent", async () => {
      createTracingAgent();
      const previous = prototype.decorate as Override;
      const calls: string[] = [];
      prototype.decorate = function (this: unknown, processor: Processor) {
        calls.push("override");
        return previous.call(this, processor);
      } satisfies Override;
      createTracingAgent();

      await expect(decorateWith(vi.fn(async () => "done"))(job)).resolves.toBe(
        "done",
      );

      expect(calls).toEqual(["override"]);
    });
  });
});

/**
 * `@taskforcesh/bullmq-pro` lives on a private registry and is never installed
 * here, so these hand the agent stand-ins shaped like it: classes extending
 * BullMQ's own, the worker calling the processor from the `callProcessJob` it
 * inherits.
 */
describe("QueueObserveAgentService: BullMQ Pro", () => {
  const ORIGINAL_CALL_PROCESS_JOB = Symbol.for(
    "nestjs.observe.bullmqPro.callProcessJob",
  );

  const stubBullMQPro = (module: unknown) =>
    vi
      .spyOn(
        QueueObserveAgentService.prototype as unknown as {
          loadBullMQPro: () => unknown;
        },
        "loadBullMQPro",
      )
      .mockReturnValue(module);

  const createProClasses = () => {
    class Worker {
      callProcessJob(job: unknown, token: string) {
        return [job, token];
      }
    }
    class WorkerPro extends Worker {}
    class QueuePro {
      add() {}
      addBulk() {}
    }
    return { Worker, WorkerPro, QueuePro };
  };

  it("patches the Pro worker and queue when @taskforcesh/bullmq-pro is installed", () => {
    const { Worker, WorkerPro, QueuePro } = createProClasses();
    const add = methodOf(QueuePro.prototype, "add");
    const addBulk = methodOf(QueuePro.prototype, "addBulk");
    stubBullMQPro({ WorkerPro, QueuePro });

    createAgent();

    expect(Object.hasOwn(WorkerPro.prototype, "callProcessJob")).toBe(true);
    expect(methodOf(WorkerPro.prototype, "callProcessJob")).not.toBe(
      methodOf(Worker.prototype, "callProcessJob"),
    );
    // BullMQ's own worker is left to `@nestjs/bullmq`'s decorator.
    expect(Object.hasOwn(Worker.prototype, ORIGINAL_CALL_PROCESS_JOB)).toBe(
      false,
    );
    expect(methodOf(QueuePro.prototype, "add")).not.toBe(add);
    expect(methodOf(QueuePro.prototype, "addBulk")).not.toBe(addBulk);
  });

  it("replaces its worker patch when a second agent starts, rather than wrapping it again", () => {
    const { Worker, WorkerPro, QueuePro } = createProClasses();
    stubBullMQPro({ WorkerPro, QueuePro });

    createAgent();
    const first = methodOf(WorkerPro.prototype, "callProcessJob");
    createAgent();

    expect(methodOf(WorkerPro.prototype, "callProcessJob")).not.toBe(first);
    expect(
      (WorkerPro.prototype as unknown as Record<symbol, unknown>)[
        ORIGINAL_CALL_PROCESS_JOB
      ],
    ).toBe(methodOf(Worker.prototype, "callProcessJob"));
  });

  it("says so, and still patches the queue, when WorkerPro has no callProcessJob", () => {
    const { QueuePro } = createProClasses();
    const add = methodOf(QueuePro.prototype, "add");
    stubBullMQPro({ WorkerPro: class WorkerPro {}, QueuePro });
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    createAgent();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("callProcessJob is not available"),
    );
    expect(methodOf(QueuePro.prototype, "add")).not.toBe(add);
  });

  it("stays silent when @taskforcesh/bullmq-pro is not installed", () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    expect(() => createAgent()).not.toThrow();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Pro"));
  });
});
