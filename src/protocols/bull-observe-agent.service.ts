import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobSnapshot,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/index.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";
import { JobTraceRunner } from "./job-trace-runner.js";

/** The fields of a Bull (v3/v4) job this agent reads, structurally typed. */
interface BullJobLike {
  id?: string | number;
  name?: string;
  timestamp?: number;
  processedOn?: number;
  delay?: number;
  attemptsMade?: number;
  opts?: Record<string, unknown> & { attempts?: number; delay?: number };
  queue?: { name?: string };
}

type BullDone = (error?: Error | null, value?: unknown) => void;
type BullHandler = (job: BullJobLike, done?: BullDone) => unknown;

interface BullQueuePrototype {
  setHandler?: (name: string, handler: unknown) => unknown;
  [key: string | symbol]: unknown;
}

const ORIGINAL_SET_HANDLER = Symbol.for("nestjs.observe.bull.setHandler");

/** Bull names an unnamed job this; reporting it would name every job the same. */
const BULL_DEFAULT_JOB_NAME = "__default__";

/**
 * Job tracing for the original Bull, which `@nestjs/bull` wraps - the same
 * snapshots `@nestjs/bullmq` produces, from a driver a large share of Nest
 * applications still run.
 *
 * Bull itself is patched rather than the Nest explorer: every processor, named
 * or not, request-scoped or not, reaches the queue through `setHandler`, so
 * one patch covers them all without depending on the explorer's internals.
 */
@Injectable()
export class BullObserveAgentService<Store extends Record<string, unknown>> {
  private readonly logger = new Logger(BullObserveAgentService.name);
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
    this.patchBull();
  }

  private loadQueuePrototype(): BullQueuePrototype | null | undefined {
    const result = loadOptionalPeer<{ prototype?: BullQueuePrototype }>("bull");
    if (!result.installed) {
      return undefined;
    }
    if (result.error) {
      this.logger.warn(
        `bull is installed but could not be loaded, so its jobs will not be instrumented: ${describePeerLoadError(result.error)}`,
      );
      return null;
    }
    return result.module?.prototype ?? null;
  }

  private readQueueMetadata(job: BullJobLike): Partial<JobSnapshot> {
    const metadata: Partial<JobSnapshot> = {};

    if (typeof job.timestamp === "number") {
      metadata.enqueuedAt = new Date(job.timestamp).toISOString();
      const startedAt =
        typeof job.processedOn === "number" ? job.processedOn : Date.now();
      // As with BullMQ: a delay the caller asked for is a schedule, not a
      // backlog, so the wait is measured from when the job became runnable.
      // `||`, not `??`: the job's own `delay` reads 0 once Bull has promoted
      // it, and only the options still say what was asked for.
      const delay = job.delay || job.opts?.delay || 0;
      metadata.waitDuration = Math.max(0, startedAt - (job.timestamp + delay));
    }
    if (typeof job.attemptsMade === "number") {
      metadata.attemptsMade = job.attemptsMade;
    }
    if (typeof job.opts?.attempts === "number") {
      metadata.maxAttempts = job.opts.attempts;
    }
    return metadata;
  }

  private patchBull() {
    const prototype = this.loadQueuePrototype();
    if (prototype === undefined) {
      // An optional peer. No Bull means no processor to wrap.
      return;
    }
    const originalSetHandler = (prototype?.[ORIGINAL_SET_HANDLER] ??
      prototype?.setHandler) as BullQueuePrototype["setHandler"];
    if (!prototype || typeof originalSetHandler !== "function") {
      this.logger.warn(
        "Bull's Queue.prototype.setHandler is not available, so its jobs will not be instrumented.",
      );
      return;
    }
    prototype[ORIGINAL_SET_HANDLER] = originalSetHandler;

    const instrument = (handler: BullHandler) => this.instrument(handler);
    prototype.setHandler = function (
      this: unknown,
      name: string,
      handler: unknown,
    ) {
      // A string is a path to a sandboxed processor. It runs in a child
      // process this agent is not loaded in, so there is nothing to wrap.
      return originalSetHandler.call(
        this,
        name,
        typeof handler === "function"
          ? instrument(handler as BullHandler)
          : handler,
      );
    };

    // add(name?, data, opts)
    this.runner.patchEnqueue(prototype, (args) =>
      typeof args[0] === "string" ? 2 : 1,
    );
  }

  /**
   * Bull decides between a promise and a callback handler by arity, after
   * binding it to the queue - so each wrapper declares the parameters of the
   * kind it stands in for, and leaves `this` to that bind.
   */
  private instrument(handler: BullHandler): BullHandler {
    const describe = (job: BullJobLike) => ({
      queueName: job.queue?.name ?? "bull",
      name:
        job.name && job.name !== BULL_DEFAULT_JOB_NAME
          ? job.name
          : job.queue?.name ?? "bull",
      id: job.id,
      opts: job.opts,
      metadata: this.readQueueMetadata(job),
    });
    const runner = this.runner;

    if (handler.length > 1) {
      return function (this: unknown, job: BullJobLike, done?: BullDone) {
        return runner.run(
          describe(job),
          (settle) =>
            handler.call(this, job, (error, value) => {
              settle(error ? "failed" : "completed");
              done?.(error, value);
            }),
          true,
        );
      };
    }
    return function (this: unknown, job: BullJobLike) {
      return runner.run(describe(job), () => handler.call(this, job));
    };
  }
}
