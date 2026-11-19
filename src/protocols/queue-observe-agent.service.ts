import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import type { Job } from "bullmq";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobSnapshot,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/index.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import {
  JobRunDescriptor,
  JobTraceRunner,
  readJobTimes,
} from "./job-trace-runner.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";

/** A processor as a worker calls it - `(job, token, signal)` on current BullMQ. */
type JobProcessor = (job: Job, ...rest: unknown[]) => unknown;

/** `ProcessorDecoratorService#decorate`, or an override of it. */
type Decorate = (this: unknown, processor: JobProcessor) => unknown;

/** The `ProcessorDecoratorService` surface this service patches, structurally typed. */
interface ProcessorDecoratorServiceLike {
  prototype?: {
    decorate?: Decorate;
  };
}

/**
 * On the agent's `decorate`: the one it stands in front of, so a second
 * agent wraps that rather than the first agent's. Kept on the wrapper, not
 * the prototype, so an override the application installs after an agent is
 * never mistaken for what that agent found.
 */
const DECORATE_IT_WRAPS = Symbol.for("nestjs.observe.bullmq.decorateItWraps");

interface WorkerProPrototypeLike {
  callProcessJob?: JobProcessor;
  [key: symbol]: unknown;
}

/** The `@taskforcesh/bullmq-pro` classes this service patches, structurally typed. */
interface BullMQProLike {
  WorkerPro?: { prototype?: WorkerProPrototypeLike };
  QueuePro?: { prototype?: Record<string | symbol, unknown> };
}

const ORIGINAL_CALL_PROCESS_JOB = Symbol.for(
  "nestjs.observe.bullmqPro.callProcessJob",
);

/**
 * Job tracing for BullMQ: through `@nestjs/bullmq`'s processor decorator, and
 * for BullMQ Pro through its worker, whichever package wires it into Nest.
 */
@Injectable()
export class QueueObserveAgentService<Store extends Record<string, unknown>> {
  private readonly logger = new Logger(QueueObserveAgentService.name);
  private readonly runner: JobTraceRunner<Store>;

  constructor(
    observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    @Inject(OBSERVE_OPTIONS)
    options: ObserveModuleOptionsWithDefaults,
    operationTraceRegistry: OperationTraceRegistry,
    asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>,
  ) {
    this.runner = new JobTraceRunner(
      observeAgentSharedBuffer,
      options,
      operationTraceRegistry,
      asyncLocalStorage,
      this.logger,
    );
    this.patchDecorate();
    this.patchBullMQPro();
  }

  private describeJob(job: Job): JobRunDescriptor {
    return {
      queueName: job.queueName,
      name: job.name,
      id: job.id,
      opts: job.opts as Record<string, unknown> | undefined,
      metadata: this.readQueueMetadata(job),
    };
  }

  /**
   * Queue-level facts BullMQ already tracks but that never reached telemetry:
   * how long the job waited before a worker took it, and which attempt this is.
   *
   * Read defensively - these are optional on the Job type and absent when a
   * queue driver does not populate them, in which case the fields are simply
   * omitted rather than reported as zero.
   */
  private readQueueMetadata(job: Job): Partial<JobSnapshot> {
    const metadata = readJobTimes(job);

    if (typeof job.attemptsMade === "number") {
      metadata.attemptsMade = job.attemptsMade;
    }

    const maxAttempts = job.opts?.attempts;
    if (typeof maxAttempts === "number") {
      metadata.maxAttempts = maxAttempts;
    }

    return metadata;
  }

  /**
   * Loads `@nestjs/bullmq`'s processor decorator without a static import, so a
   * service that runs no queue need not install the package. The prototype is
   * patched from the constructor, strictly before any processor is decorated.
   *
   * Returns `undefined` when the package is not installed and `null` when it
   * is, but does not expose the decorator service where expected.
   */
  private loadProcessorDecoratorService():
    | ProcessorDecoratorServiceLike
    | null
    | undefined {
    const result = loadOptionalPeer<{
      ProcessorDecoratorService?: ProcessorDecoratorServiceLike;
    }>("@nestjs/bullmq");
    if (!result.installed) {
      return undefined;
    }
    if (result.error) {
      // The real cause - a version that no longer re-exports it, a broken
      // install - so the "update to the latest version" advice below is
      // never the only diagnostic.
      this.logger.warn(
        `@nestjs/bullmq is installed but its processor decorator could not be loaded: ${describePeerLoadError(result.error)}`,
      );
      return null;
    }
    return result.module?.ProcessorDecoratorService ?? null;
  }

  private patchDecorate() {
    const ProcessorDecoratorService = this.loadProcessorDecoratorService();
    if (ProcessorDecoratorService === undefined) {
      // The @nestjs/bullmq package is an optional peer. No queue means no
      // processor to wrap, and that is not a misconfiguration.
      return;
    }
    if (!ProcessorDecoratorService?.prototype) {
      this.logger.warn(
        "ProcessorDecoratorService is not available. Please, update to the latest version of @nestjs/bullmq. Skipping patching.",
      );
      return;
    }

    // `decorate` is documented as the place to override, and the application
    // may have: a check that refuses a job, a wrapper of its own. What is
    // there is called, as the explorer would call it, and the job is traced
    // around what it returns. An earlier agent's wrapper is seen through, to
    // what that agent found.
    const prototype = ProcessorDecoratorService.prototype;
    const found = prototype.decorate;
    const original =
      typeof found === "function" &&
      Object.prototype.hasOwnProperty.call(found, DECORATE_IT_WRAPS)
        ? (found as Decorate & { [DECORATE_IT_WRAPS]?: Decorate })[
            DECORATE_IT_WRAPS
          ]
        : found;
    const runner = this.runner;
    const describeJob = (job: Job) => this.describeJob(job);

    // The worker calls the processor with `(job, token, signal)`, and all of it
    // is passed on: a processor that moves its own job (`moveToDelayed`,
    // `extendLock`) needs the token to prove it holds the lock.
    //
    // And the wrapper declares as many parameters as the processor it stands
    // in for does: the worker builds a job's abort signal only for a
    // processor that declares three, so a rest parameter, whose `length` is
    // 1, left every `process(job, token, signal)` without one and
    // `cancelJob()` with nothing to abort.
    const decorate: Decorate = function (this: unknown, processor) {
      const decorated =
        typeof original === "function"
          ? original.call(this, processor)
          : processor;
      if (typeof decorated !== "function") {
        return decorated;
      }
      const traced = (job: Job, ...rest: unknown[]) =>
        runner.run(describeJob(job), () =>
          (decorated as JobProcessor)(job, ...rest),
        );
      Object.defineProperty(traced, "length", {
        value: decorated.length,
        configurable: true,
      });
      return traced;
    };
    Object.defineProperty(decorate, DECORATE_IT_WRAPS, { value: original });
    prototype.decorate = decorate;

    this.patchQueue();
  }

  /**
   * The enqueuing half: without it a worker has no way to learn which
   * operation a job came from, and every run opens an unrelated trace.
   *
   * `bullmq` is loaded the way `@nestjs/bullmq` loads it, so the prototype
   * patched here is the one behind every `@InjectQueue()`.
   */
  private patchQueue() {
    const result = loadOptionalPeer<{
      Queue?: { prototype?: Record<string | symbol, unknown> };
    }>("bullmq");
    if (!result.installed) {
      return;
    }
    const prototype = result.module?.Queue?.prototype;
    if (!prototype) {
      this.logger.warn(
        `bullmq is installed but its Queue could not be loaded, so jobs will not inherit the trace that enqueued them${result.error ? `: ${describePeerLoadError(result.error)}` : "."}`,
      );
      return;
    }
    // add(name, data, opts)
    this.runner.patchEnqueue(prototype, () => 2);
  }

  /**
   * Loads `@taskforcesh/bullmq-pro` - an optional peer, published only to
   * Taskforce's own registry - the same way as the packages above.
   *
   * Returns `undefined` both when it is not installed, which is the normal
   * case, and when it is installed but cannot be loaded, which is said out
   * loud.
   */
  private loadBullMQPro(): BullMQProLike | undefined {
    const result = loadOptionalPeer<BullMQProLike>("@taskforcesh/bullmq-pro");
    if (!result.installed) {
      return undefined;
    }
    if (!result.module) {
      this.logger.warn(
        `@taskforcesh/bullmq-pro is installed but could not be loaded, so BullMQ Pro jobs will not be instrumented${result.error ? `: ${describePeerLoadError(result.error)}` : "."}`,
      );
      return undefined;
    }
    return result.module;
  }

  /**
   * BullMQ Pro, whichever way it is wired into Nest.
   *
   * `@taskforcesh/nestjs-bullmq-pro` is a fork of `@nestjs/bullmq` from before
   * the processor decorator existed: its explorer hands `process` straight to
   * a `WorkerPro`, and there is no seam on the Nest side to patch. The worker
   * is patched instead. Every job a `WorkerPro` runs goes through the
   * `callProcessJob` it inherits from BullMQ's `Worker`, so one patch covers
   * the fork, `@nestjs/bullmq` told to build Pro workers
   * (`BullModule.workerClass`), and a worker built by hand - without depending
   * on anybody's explorer. Where `@nestjs/bullmq` decorated the processor too,
   * the runner recognises the job it is already running and opens no second
   * trace.
   *
   * `QueuePro` overrides `add` and `addBulk`, and an override need not go
   * through `Queue.prototype.add`, so the enqueuing half is patched on
   * `QueuePro` itself.
   */
  private patchBullMQPro() {
    const bullmqPro = this.loadBullMQPro();
    if (!bullmqPro) {
      return;
    }
    this.patchWorkerPro(bullmqPro.WorkerPro?.prototype);

    const queuePrototype = bullmqPro.QueuePro?.prototype;
    if (!queuePrototype) {
      this.logger.warn(
        "@taskforcesh/bullmq-pro does not expose QueuePro, so BullMQ Pro jobs will not inherit the trace that enqueued them.",
      );
      return;
    }
    // add(name, data, opts)
    this.runner.patchEnqueue(queuePrototype, () => 2);
  }

  private patchWorkerPro(prototype: WorkerProPrototypeLike | undefined) {
    // Parked as an own property, like the queue's originals: a second agent
    // replaces the wrapper instead of wrapping it again.
    if (
      prototype &&
      !Object.prototype.hasOwnProperty.call(
        prototype,
        ORIGINAL_CALL_PROCESS_JOB,
      )
    ) {
      prototype[ORIGINAL_CALL_PROCESS_JOB] = prototype.callProcessJob;
    }
    const original = prototype?.[ORIGINAL_CALL_PROCESS_JOB];
    if (!prototype || typeof original !== "function") {
      this.logger.warn(
        "BullMQ Pro's WorkerPro.prototype.callProcessJob is not available, so BullMQ Pro jobs will not be instrumented.",
      );
      return;
    }

    const runner = this.runner;
    const describe = (job: Job) => this.describeJob(job);
    prototype.callProcessJob = function (
      this: unknown,
      job: Job,
      ...rest: unknown[]
    ) {
      // Nothing to describe; instrumentation must never be why a run fails.
      if (typeof job !== "object" || job === null) {
        return original.call(this, job, ...rest);
      }
      return runner.run(describe(job), () => original.call(this, job, ...rest));
    };
  }
}
