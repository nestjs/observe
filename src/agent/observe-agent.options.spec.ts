import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/**
 * Covers option resolution, not the agent.
 *
 * `runtimeMetrics` gauges how loaded a process is; `profiling` samples stacks
 * to say which code it was running. They are different signals with different
 * costs, and the cases below are mostly about keeping them independent - the
 * cheap one must not switch on the one that samples the hot path.
 *
 * `profiling` is currently shelved - commented out of `ObserveOptions`, and
 * `startContinuousProfiling()` is no longer called - so the cases that mention
 * it assert that it stays off. The implementation is kept and tested
 * elsewhere; these guard the wiring for the day it comes back.
 *
 * `runtimeMetrics` was once called `profiler`, one letter from `profiling` for
 * an unrelated signal. The alias has since been removed outright.
 */
describe("ObserveAgentWorker options", () => {
  const collect = vi.fn();
  const sharedBuffer = {
    addNodeRuntimeMetrics: vi.fn(),
    drainPendingLogs: vi.fn(),
    resetMainThreadBuffer: vi.fn(),
    isBufferEmpty: vi.fn(() => false),
    isBufferLocked: vi.fn(() => false),
    acquireLock: vi.fn(() => true),
    encodeAndWrite: vi.fn(),
    releaseLock: vi.fn(),
    recordStarted: vi.fn(),
  };
  const metrics = { collectNodeRuntimeMetrics: collect };

  let worker: ObserveAgentWorker;

  const build = (options: Partial<ObserveModuleOptionsWithDefaults>) => {
    worker = new ObserveAgentWorker(
      sharedBuffer as never,
      // With credentials, as the agent always runs: without them it starts
      // nothing against the hosted collector - see the cases at the end.
      {
        serviceId: "svc",
        appKey: "k",
        appSecret: "s",
        ...options,
      } as ObserveModuleOptionsWithDefaults,
      metrics as never,
    );
    // The worker thread and the profiler are out of scope here; only the
    // option resolution is under test.
    vi.spyOn(worker, "initializeWorker").mockImplementation(() => undefined);
    return worker;
  };

  const runtimeMetricsStarted = () =>
    Boolean(
      (worker as unknown as { runtimeMetricsInterval: unknown })
        .runtimeMetricsInterval,
    );

  afterEach(async () => {
    await worker?.onApplicationShutdown();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("flushInterval", () => {
    // The flush itself touches the shared buffer, which is a stub here; only
    // the cadence the timer was armed with is under test.
    const armFlush = (options: Partial<ObserveModuleOptionsWithDefaults>) => {
      vi.useFakeTimers();
      build(options);
      const flush = vi
        .spyOn(worker, "flush")
        .mockImplementation(() => undefined);
      const warn = vi
        .spyOn(
          (worker as unknown as { logger: { warn: (m: string) => void } })
            .logger,
          "warn",
        )
        .mockImplementation(() => undefined);
      worker.onModuleInit();
      return { flush, warn };
    };

    it("flushes at the minimum cadence when asked for less", () => {
      // Used to warn that the interval had been raised to 1s and then arm the
      // timer with the original value anyway - `flushInterval: 50` flushed
      // twenty times a second while claiming otherwise.
      const { flush, warn } = armFlush({ flushInterval: 50 });

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Setting to minimum of 1000ms"),
      );

      vi.advanceTimersByTime(999);
      expect(flush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(flush).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1000);
      expect(flush).toHaveBeenCalledTimes(2);
    });

    it("keeps an interval at or above the minimum as given", () => {
      const { flush, warn } = armFlush({ flushInterval: 2500 });

      expect(warn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2499);
      expect(flush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("settles the interval before the worker starts, which backs off from it", () => {
      // The worker's first pause after rejected credentials is one flush
      // interval, read when it starts - so the clamp has to come first, or a
      // `flushInterval: 50` would back off from 50ms.
      vi.useFakeTimers();
      build({ flushInterval: 50 });
      let seenAtStart: number | undefined;
      vi.mocked(worker.initializeWorker).mockImplementation(() => {
        seenAtStart = (
          worker as unknown as { options: { flushInterval?: number } }
        ).options.flushInterval;
      });
      vi.spyOn(
        (worker as unknown as { logger: { warn: (m: string) => void } }).logger,
        "warn",
      ).mockImplementation(() => undefined);

      worker.onModuleInit();

      expect(worker.initializeWorker).toHaveBeenCalledTimes(1);
      expect(seenAtStart).toBe(1000);
    });

    it("defaults to five seconds when the option is not set", () => {
      const { flush, warn } = armFlush({});

      expect(warn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4999);
      expect(flush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  it("collects runtime metrics when asked by the new name", () => {
    build({ runtimeMetrics: true }).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(true);
  });

  // `process.memoryUsage()` opens /proc/self/stat, and throws when no file
  // descriptor is free - which a flood of idle connections can arrange. Out
  // of a bare timer, that would be an uncaught exception in the host.
  it("skips a runtime sample that cannot be taken, and takes the next", () => {
    vi.useFakeTimers();
    build({ runtimeMetrics: true }).onModuleInit();
    collect
      .mockImplementationOnce(() => {
        throw Object.assign(
          new Error("EMFILE: too many open files, uv_resident_set_memory"),
          { code: "EMFILE" },
        );
      })
      .mockImplementationOnce(() => ({ sample: 2 }));

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(sharedBuffer.addNodeRuntimeMetrics).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60_000);
    expect(sharedBuffer.addNodeRuntimeMetrics).toHaveBeenCalledWith({
      sample: 2,
    });
  });

  it("does not collect when explicitly switched off", () => {
    build({ runtimeMetrics: false }).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("treats an unset option as off, leaving the default to the metrics service", () => {
    // Not what an application sees: by the time the worker reads the option,
    // NodeRuntimeMetricsService - which it is injected with - has defaulted it
    // to true in its own constructor. The stub here does not, which leaves the
    // worker's own reading under test, so the default lives in one place.
    build({}).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("does not start the sampling profiler alongside runtime metrics", () => {
    // The whole reason for the rename: these are different signals with
    // different costs, and enabling the cheap one must not enable the one that
    // samples the hot path.
    build({ runtimeMetrics: true }).onModuleInit();

    expect(
      (worker as unknown as { cpuProfiler: unknown }).cpuProfiler,
    ).toBeNull();
  });

  // `profiling` is shelved: the option is commented out of ObserveOptions and
  // `startContinuousProfiling()` is no longer called from `onModuleInit`. The
  // implementation stays, so the independence this spec is about still has to
  // hold the day it is restored - hence the cast rather than deleting the case.
  // If passing it ever *does* start something, that is the regression.
  it("does not start runtime metrics alongside the sampling profiler", () => {
    build({
      profiling: { enabled: true },
    } as Partial<ObserveModuleOptionsWithDefaults>).onModuleInit();

    expect(runtimeMetricsStarted()).toBe(false);
  });

  it("leaves the shelved profiler switched off even when asked for it", () => {
    build({
      profiling: { enabled: true },
    } as Partial<ObserveModuleOptionsWithDefaults>).onModuleInit();

    expect(
      (worker as unknown as { cpuProfiler: unknown }).cpuProfiler,
    ).toBeNull();
  });

  // `nest new --observe` writes these into AppModule. Until someone signs up
  // they mean "not connected yet": sending them only earns a 401 and an
  // `Error:` line on the first start, so the agent points at the demo instead.
  describe("with the credentials nest new generates", () => {
    const scaffold = {
      appKey: "YOUR_APP_KEY",
      appSecret: "YOUR_APP_SECRET",
      runtimeMetrics: true,
    };

    const spyLogger = () => {
      const logger = (
        worker as unknown as {
          logger: {
            log: (m: string) => void;
            error: (m: string) => void;
          };
        }
      ).logger;
      return {
        log: vi.spyOn(logger, "log").mockImplementation(() => undefined),
        error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
      };
    };

    it("points at link and the demo instead of starting the worker", () => {
      build(scaffold);
      const { log, error } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          "https://www.observe-demo.nestjs.com/dashboard",
        ),
      );
      // Link signs the developer up if they have no account, so the one
      // command replaces the old "create a free account" pointer.
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("npx @nestjs/observe link"),
      );
      expect(error).not.toHaveBeenCalled();
    });

    it("does not collect runtime metrics nobody will receive", () => {
      build(scaffold);
      spyLogger();
      worker.onModuleInit();

      expect(runtimeMetricsStarted()).toBe(false);
    });

    it("empties the buffer on flush without handing anything off", () => {
      build(scaffold).flush();

      expect(sharedBuffer.resetMainThreadBuffer).toHaveBeenCalled();
      expect(sharedBuffer.encodeAndWrite).not.toHaveBeenCalled();
    });

    it("starts normally when only one of the two is a placeholder", () => {
      build({ ...scaffold, appSecret: "real-secret" });
      const { log } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });

  // A deployment whose environment never reached the process: the worker
  // leaves both headers off, which a collector in placeholder mode accepts,
  // and which the hosted collector answers with a 401 for as long as the
  // process runs - 42% of the 1.87M batches it refused on 2026-10-15.
  describe("without credentials", () => {
    const HOSTED = "https://observe-api.nestjs.com";
    const none = { appKey: undefined, appSecret: undefined };

    const spyLogger = () => {
      const logger = (
        worker as unknown as {
          logger: {
            log: (m: string) => void;
            warn: (m: string) => void;
            error: (m: string) => void;
          };
        }
      ).logger;
      return {
        log: vi.spyOn(logger, "log").mockImplementation(() => undefined),
        warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
        error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
      };
    };

    it("starts nothing against the hosted collector and says why, once", () => {
      build({ ...none, endpoint: HOSTED, runtimeMetrics: true });
      const { warn, error } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("appKey and appSecret are not set"),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("https://observe.nestjs.com"),
      );
      // Not an error: the application is fine, it is only not observed.
      expect(error).not.toHaveBeenCalled();
      // Nobody would receive the samples.
      expect(runtimeMetricsStarted()).toBe(false);
    });

    it.each([
      ["appKey", { appKey: undefined, appSecret: "s" }, "appKey is not set"],
      [
        "appSecret",
        { appKey: "k", appSecret: undefined },
        "appSecret is not set",
      ],
      ["an empty appKey", { appKey: "", appSecret: "s" }, "appKey is not set"],
    ])("names what is missing: %s", (_, credentials, named) => {
      build({ ...credentials, endpoint: HOSTED });
      const { warn } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(named));
    });

    it("knows the hosted collector however its URL is written", () => {
      build({ ...none, endpoint: "https://OBSERVE-API.nestjs.com/" });
      spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
    });

    it("empties the buffer on flush without handing anything off", () => {
      build({ ...none, endpoint: HOSTED }).flush();

      expect(sharedBuffer.resetMainThreadBuffer).toHaveBeenCalled();
      expect(sharedBuffer.encodeAndWrite).not.toHaveBeenCalled();
    });

    it("still sends to a collector of the user's own, which may take batches without them", () => {
      build({ ...none, endpoint: "http://127.0.0.1:4000" });
      const { warn } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  // `enabled: false` is how an application keeps the module imported in an
  // environment that should not report - local development, most often -
  // without fake credentials, which would be sent and refused.
  describe("disabled", () => {
    const spyLogger = () => {
      const logger = (
        worker as unknown as {
          logger: {
            log: (m: string) => void;
            warn: (m: string) => void;
            error: (m: string) => void;
          };
        }
      ).logger;
      return {
        log: vi.spyOn(logger, "log").mockImplementation(() => undefined),
        warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
        error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
      };
    };

    it("starts no worker and says so once, even with credentials", () => {
      build({ enabled: false, runtimeMetrics: true });
      const { log, warn, error } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("enabled: false"),
      );
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(runtimeMetricsStarted()).toBe(false);
    });

    it("does not warn about credentials it does not need", () => {
      build({
        enabled: false,
        appKey: undefined,
        appSecret: undefined,
        endpoint: "https://observe-api.nestjs.com",
      });
      const { warn } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("sends nothing to a collector of the user's own either", () => {
      build({ enabled: false, endpoint: "http://127.0.0.1:4000" });
      spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).not.toHaveBeenCalled();
    });

    it("empties the buffer on flush without handing anything off", () => {
      build({ enabled: false }).flush();

      expect(sharedBuffer.resetMainThreadBuffer).toHaveBeenCalled();
      expect(sharedBuffer.encodeAndWrite).not.toHaveBeenCalled();
    });

    it("runs as before when switched on explicitly", () => {
      build({ enabled: true });
      const { log } = spyLogger();
      worker.onModuleInit();

      expect(worker.initializeWorker).toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });
  });
});
