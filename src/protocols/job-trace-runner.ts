import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobContext,
  JobSnapshot,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/index.js";
import {
  JOB_TRACE_OPTION_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import { REQUEST_ID_PATTERN } from "../utils/default-trace-id-generator.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";

/** What a queue driver knows about the run it is about to start. */
export interface JobRunDescriptor {
  queueName: string;
  name: string;
  id?: string | number;
  /** The job's options as the driver read them back from Redis. */
  opts?: Record<string, unknown>;
  metadata: Partial<JobSnapshot>;
}

type JobStatus = NonNullable<JobSnapshot["status"]>;

/** The slice of a queue's prototype the enqueue patch touches. */
interface QueuePrototypeLike {
  add?: (...args: any[]) => unknown;
  addBulk?: (jobs: any[]) => unknown;
  [key: symbol]: unknown;
}

const ORIGINAL_ADD = Symbol.for("nestjs.observe.queue.add");
const ORIGINAL_ADD_BULK = Symbol.for("nestjs.observe.queue.addBulk");

/**
 * The part of job tracing that is the same whichever driver runs the queue:
 * stamping the active trace id onto a job as it is enqueued, and opening the
 * run under that id when a worker picks it up.
 *
 * A plain class rather than a provider - each driver agent builds its own from
 * what it was injected with, so supporting another driver adds no wiring to
 * the module.
 */
export class JobTraceRunner<Store extends Record<string, unknown>> {
  constructor(
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    private readonly logger: Logger,
  ) {}

  /**
   * Makes `add` and `addBulk` carry the enqueuing operation's trace id, so the
   * run reports under the request - or job, or cron firing - that caused it.
   *
   * The originals are parked on the prototype under a symbol: a second agent
   * (a second Nest app in one process, a test suite) replaces the wrapper
   * instead of wrapping it again.
   */
  patchEnqueue(
    prototype: QueuePrototypeLike,
    /** Index of the options argument in `add`, given the arguments passed. */
    optsIndexOf: (args: unknown[]) => number,
  ) {
    const stamp = (opts: unknown) => this.stampTraceId(opts);

    const originalAdd = (prototype[ORIGINAL_ADD] ??= prototype.add) as
      | QueuePrototypeLike["add"]
      | undefined;
    if (typeof originalAdd === "function") {
      prototype.add = function (this: unknown, ...args: unknown[]) {
        const index = optsIndexOf(args);
        const stamped = stamp(args[index]);
        if (stamped) {
          args[index] = stamped;
        }
        return originalAdd.apply(this, args);
      };
    }

    const originalAddBulk = (prototype[ORIGINAL_ADD_BULK] ??=
      prototype.addBulk) as QueuePrototypeLike["addBulk"] | undefined;
    if (typeof originalAddBulk === "function") {
      prototype.addBulk = function (this: unknown, jobs: any[]) {
        if (!Array.isArray(jobs)) {
          return originalAddBulk.call(this, jobs);
        }
        return originalAddBulk.call(
          this,
          jobs.map((job) => {
            const stamped = stamp(job?.opts);
            return stamped ? { ...job, opts: stamped } : job;
          }),
        );
      };
    }
  }

  /**
   * Returns the options with the active trace id added, or `undefined` when
   * there is nothing to add.
   *
   * A repeatable job is left alone: every repetition would otherwise report
   * under the one request that happened to register the schedule, for as long
   * as the schedule lives. Those runs are cron firings, and each mints its own
   * id like any other.
   */
  private stampTraceId(opts: unknown): Record<string, unknown> | undefined {
    const traceId = this.asyncLocalStorage
      .getStore()
      ?.get(this.options.traceIdKey);
    if (typeof traceId !== "string") {
      return undefined;
    }
    if (opts !== undefined && (typeof opts !== "object" || opts === null)) {
      return undefined;
    }
    const current = (opts ?? {}) as Record<string, unknown>;
    if (current["repeat"] || current[JOB_TRACE_OPTION_KEY] !== undefined) {
      return undefined;
    }
    return { ...current, [JOB_TRACE_OPTION_KEY]: traceId };
  }

  /**
   * The id stamped at enqueue time, if it is one this agent would have minted
   * or adopted itself. Job options are readable and writable by anything with
   * access to Redis, so it is held to the same shape as an inbound
   * `x-request-id`.
   */
  private readInheritedTraceId(
    opts: Record<string, unknown> | undefined,
  ): string | undefined {
    const inherited = opts?.[JOB_TRACE_OPTION_KEY];
    return typeof inherited === "string" && REQUEST_ID_PATTERN.test(inherited)
      ? inherited
      : undefined;
  }

  /**
   * Runs one job under a trace.
   *
   * `invoke` is handed `settle` for drivers whose handlers finish through a
   * callback; pass `settlesItself` for those, and a plain return is then not
   * read as completion. Promise-returning and throwing handlers are settled
   * here either way.
   */
  run<T>(
    job: JobRunDescriptor,
    invoke: (settle: (status: JobStatus) => void) => T,
    settlesItself = false,
  ): T {
    const hasOuterContext = this.asyncLocalStorage
      .getStore()
      ?.has(this.options.traceIdKey);

    // The same map `run` is given, rather than `getStore()` inside the
    // callback: identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      if (hasOuterContext) {
        // If the outer context already has a trace ID
        // ignore the inner context
        if (this.options.debug) {
          this.logger.debug(
            `Outer context already has a trace ID. Skipping inner context for job "${job.name}" job.id: ${job.id}`,
          );
        }
        return invoke(() => undefined);
      }

      // The registry key is always this run's own. The inherited id may belong
      // to a request still open in this process, and a retry reuses it.
      const registryKey = uuidv7();
      const traceId = this.readInheritedTraceId(job.opts) ?? registryKey;
      store.set(this.options.traceIdKey, traceId);
      store.set(TRACE_REGISTRY_KEY as KeyOf<Store>, registryKey);

      const context: JobContext = {
        queueName: job.queueName,
        name: job.name,
        id: typeof job.id === "number" ? `${job.id}` : job.id,
      };

      const attributes = this.options.jobs?.setAttributes?.(context);
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          store.set(key, value);
        }
      }

      if (this.options.jobs?.ignore?.(context)) {
        // The trace id stays in the store so logs and jobs enqueued from here
        // still correlate; nothing is registered under the registry key, so
        // its spans have no trace to join.
        return invoke(() => undefined);
      }

      this.operationTraceRegistry.startTrace(
        registryKey,
        {
          tags: this.options.jobs?.tags,
          ...context,
          ...job.metadata,
        } as JobSnapshot,
        traceId,
      );

      let settled = false;
      const settle = (status: JobStatus) => {
        if (settled) {
          return;
        }
        settled = true;
        setTimeout(async () => {
          this.operationTraceRegistry.endTrace(registryKey, { status });

          const snapshot = (await this.operationTraceRegistry.pluckSnapshot(
            registryKey,
          )) as JobSnapshot | undefined;

          // `pluckSnapshot` deletes what it returns, so a trace already
          // plucked answers undefined, and the encoder would dereference it
          // inside a `setTimeout`, where no try/catch can reach: an unhandled
          // TypeError that took the whole process down.
          //
          // Dropped rather than reported: there is no snapshot, so there is
          // nothing to send, and losing one job's self-instrumentation is
          // not worth a crash loop.
          if (!snapshot) {
            return;
          }
          this.observeAgentSharedBuffer.insertJobSnapshot(snapshot);
        }, 0);
      };

      try {
        const returnValue = invoke(settle);
        if (returnValue instanceof Promise) {
          return returnValue
            .then((ret) => {
              settle("completed");
              return ret;
            })
            .catch((error: Error) => {
              settle("failed");
              throw error;
            }) as T;
        }

        if (!settlesItself) {
          settle("completed");
        }
        return returnValue;
      } catch (error) {
        settle("failed");
        throw error;
      }
    });
  }
}
