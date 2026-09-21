import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import type { Job, Processor } from "bullmq";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobSnapshot,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/index.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { JobTraceRunner } from "./job-trace-runner.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";

/** The `ProcessorDecoratorService` surface this service patches, structurally typed. */
interface ProcessorDecoratorServiceLike {
  prototype?: {
    decorate?: (
      processor: Processor<unknown, unknown>,
    ) => (job: Job) => unknown;
  };
}

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
    const metadata: Partial<JobSnapshot> = {};

    if (typeof job.timestamp === "number") {
      metadata.enqueuedAt = new Date(job.timestamp).toISOString();

      // processedOn is set by the worker immediately before the processor runs.
      // Falling back to now() keeps the measurement honest if it is missing.
      const startedAt =
        typeof job.processedOn === "number" ? job.processedOn : Date.now();

      // `timestamp` is when the job was created, not when it became runnable, so
      // for a delayed job the gap between the two is a schedule the caller asked
      // for - not a queue that fell behind. Counting it would report a job dated
      // a week out as a week of backlog and drag `job_wait_p95` with it.
      //
      // Read off the options when `job.delay` is zero: BullMQ resets that
      // field as it promotes a delayed job, so by the time a worker holds the
      // job it says 0 whatever was asked for.
      const availableAt = job.timestamp + (job.delay || job.opts?.delay || 0);
      metadata.waitDuration = Math.max(0, startedAt - availableAt);
    }

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

    ProcessorDecoratorService.prototype["decorate"] =
      (processor: Processor<unknown, unknown>) => (job: Job) =>
        this.runner.run(
          {
            queueName: job.queueName,
            name: job.name,
            id: job.id,
            opts: job.opts as Record<string, unknown> | undefined,
            metadata: this.readQueueMetadata(job),
          },
          () => processor(job),
        );

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
}
