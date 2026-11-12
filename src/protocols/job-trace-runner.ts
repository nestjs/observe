import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobContext,
  JobSnapshot,
  ObserveModuleOptionsWithDefaults,
} from "../interfaces/index.js";
import {
  JOB_TRACE_CONTEXT_OPTION_KEY,
  JOB_TRACE_OPTION_KEY,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import { REQUEST_ID_PATTERN } from "../utils/default-trace-id-generator.util.js";
import { handedOnTraceContext } from "../utils/trace-context.util.js";
import {
  continueHandedOnTrace,
  traceparentToHandOn,
} from "../utils/trace-handoff.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import {
  deferTraceCompletion,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";
import {
  endOperation,
  liveTraceId,
  openOperation,
} from "../utils/operation-state.util.js";

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

/** The later of the two ends of the range a `Date` can hold, in ms. */
const MAX_DATE_TIMESTAMP = 8.64e15;

/** What a queue driver read back of a job's times. */
interface JobTimes {
  /** When the job was created. */
  timestamp?: unknown;
  /** When the worker took it, set just before the processor runs. */
  processedOn?: unknown;
  /** The delay still pending, which BullMQ and Bull reset on promotion. */
  delay?: unknown;
  opts?: { delay?: unknown };
}

/**
 * When a job was enqueued, and how long it waited for a worker once it could
 * run - left out when its times are not ones a `Date` can hold.
 *
 * Job fields are read back from Redis, which anything with access to it can
 * write, and BullMQ takes a caller's `timestamp` option unchecked:
 * `new Date(8.64e15 + 1).toISOString()` throws, and adding an object-valued
 * `delay` to a number throws too. Both ran before the processor, so the
 * worker failed a job that completes without the agent.
 *
 * `timestamp` is when the job was created, not when it became runnable, so for
 * a delayed job the gap between the two is a schedule the caller asked for -
 * not a queue that fell behind. Counting it would report a job dated a week
 * out as a week of backlog and drag `job_wait_p95` with it. The delay is read
 * off the options when the job's own reads 0: it is reset as a delayed job is
 * promoted, so by the time a worker holds the job it says 0 whatever was
 * asked for. `||`, not `??`, for that reason.
 */
export function readJobTimes(job: JobTimes): Partial<JobSnapshot> {
  const { timestamp } = job;
  if (!isDateTimestamp(timestamp)) {
    return {};
  }
  // Falling back to now() keeps the measurement honest if it is missing.
  const startedAt = isDateTimestamp(job.processedOn)
    ? job.processedOn
    : Date.now();
  const asked = job.delay || job.opts?.delay;
  const delay = typeof asked === "number" && Number.isFinite(asked) ? asked : 0;
  return {
    enqueuedAt: new Date(timestamp).toISOString(),
    waitDuration: Math.max(0, startedAt - (timestamp + delay)),
  };
}

function isDateTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= MAX_DATE_TIMESTAMP
  );
}

/** The slice of a queue's prototype the enqueue patch touches. */
interface QueuePrototypeLike {
  add?: (...args: any[]) => unknown;
  addBulk?: (jobs: any[]) => unknown;
  [key: symbol]: unknown;
}

const ORIGINAL_ADD = Symbol.for("nestjs.observe.queue.add");
const ORIGINAL_ADD_BULK = Symbol.for("nestjs.observe.queue.addBulk");

/** Where a run records which job it is running, for a layer nested inside it. */
const ACTIVE_JOB_KEY = Symbol("nestjs.observe.activeJob");

interface ActiveJob {
  queueName: string;
  id: string;
}

/**
 * The method a prototype had before any agent patched it, parked on that
 * prototype under `key` the first time round, so a second agent (a second Nest
 * app in one process, a test suite) replaces the wrapper instead of wrapping it
 * again.
 *
 * Own properties only. A subclass prototype - `QueuePro` over BullMQ's `Queue` -
 * would otherwise read the original its parent parked through the prototype
 * chain, and the wrapper would call *that*, skipping the subclass's own
 * override altogether.
 */
function parkOriginal(
  prototype: QueuePrototypeLike,
  key: symbol,
  method: "add" | "addBulk",
): unknown {
  if (!Object.prototype.hasOwnProperty.call(prototype, key)) {
    prototype[key] = prototype[method];
  }
  return prototype[key];
}

function isSameJob(outer: unknown, job: ActiveJob): boolean {
  const active = outer as ActiveJob | undefined;
  return active?.queueName === job.queueName && active.id === job.id;
}

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
   * The originals are parked on the prototype itself (see `parkOriginal`).
   */
  patchEnqueue(
    prototype: QueuePrototypeLike,
    /** Index of the options argument in `add`, given the arguments passed. */
    optsIndexOf: (args: unknown[]) => number,
  ) {
    const stamp = (opts: unknown) => this.stampTraceId(opts);

    const originalAdd = parkOriginal(prototype, ORIGINAL_ADD, "add") as
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

    const originalAddBulk = parkOriginal(
      prototype,
      ORIGINAL_ADD_BULK,
      "addBulk",
    ) as QueuePrototypeLike["addBulk"] | undefined;
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
   *
   * With OpenTelemetry interop on, a W3C `traceparent` goes beside the id, for
   * an OpenTelemetry SDK in the worker's process to continue - see
   * `traceparentToHandOn`.
   */
  private stampTraceId(opts: unknown): Record<string, unknown> | undefined {
    const store = this.asyncLocalStorage.getStore();
    // A job a finished operation's timer enqueues, past the grace period,
    // is no part of that operation's trace.
    const traceId = liveTraceId(store, this.options.traceIdKey);
    if (traceId === undefined) {
      return undefined;
    }
    if (opts !== undefined && (typeof opts !== "object" || opts === null)) {
      return undefined;
    }
    const current = (opts ?? {}) as Record<string, unknown>;
    if (current["repeat"] || current[JOB_TRACE_OPTION_KEY] !== undefined) {
      return undefined;
    }
    const stamped: Record<string, unknown> = {
      ...current,
      [JOB_TRACE_OPTION_KEY]: traceId,
    };
    if (
      this.openTelemetryInteropOn() &&
      current[JOB_TRACE_CONTEXT_OPTION_KEY] === undefined
    ) {
      stamped[JOB_TRACE_CONTEXT_OPTION_KEY] = traceparentToHandOn(
        store,
        traceId,
      );
    }
    return stamped;
  }

  /**
   * Whether OpenTelemetry interop runs now: `openTelemetry` on, beside
   * reporting to NestJS Observe - see `ObserveAgentSharedBuffer.isReporting`.
   * Asked as a job is enqueued and again as it starts, by each side for
   * itself.
   */
  private openTelemetryInteropOn(): boolean {
    return (
      this.options.openTelemetry === true &&
      this.observeAgentSharedBuffer.isReporting()
    );
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
   * What identifies the run to a layer nested inside it: the queue and the
   * job id, rather than the job object, which a driver is free to wrap or
   * rebuild on its way to the processor. A retry is a later run, never a
   * nested one, so the two cannot be told apart by accident. A run without
   * an id has nothing to be recognised by.
   */
  private activeJobOf(job: JobRunDescriptor): ActiveJob | undefined {
    return job.id === undefined
      ? undefined
      : { queueName: job.queueName, id: String(job.id) };
  }

  /**
   * Whether `jobs.ignore` matches this run. A predicate that throws is read
   * as a match, as every other protocol reads its own: the job still runs,
   * just without a trace.
   */
  private isIgnored(context: JobContext): boolean {
    // Jobs never reach the sampler, which is where every other protocol
    // learns that the agent is disabled.
    if (this.options.enabled === false) {
      return true;
    }
    return shouldIgnoreSafely(
      this.options.jobs?.ignore,
      [context],
      this.options.jobs,
      this.logger,
      "jobs",
    );
  }

  /**
   * Runs one job under a trace.
   *
   * `invoke` is handed `settle` for drivers whose handlers finish through a
   * callback; pass `settlesItself` for those, and what the handler returns,
   * a promise included, is then not read as the outcome. A throwing handler
   * is settled here either way, and a promise goes back to the driver as the
   * handler returned it.
   */
  run<T>(
    job: JobRunDescriptor,
    invoke: (settle: (status: JobStatus) => void) => T,
    settlesItself = false,
  ): T {
    const outerStore = this.asyncLocalStorage.getStore();
    const activeJob = this.activeJobOf(job);

    // A second layer of instrumentation around a run that is already open -
    // a BullMQ Pro worker whose processor `@nestjs/bullmq` decorated as well.
    // The layer that saw the job first owns the trace; this one runs the job
    // inside it. Taking the branch below instead would hide that trace behind
    // an empty store, and the run would report without a single span.
    if (
      activeJob &&
      isSameJob(outerStore?.get(ACTIVE_JOB_KEY as KeyOf<Store>), activeJob)
    ) {
      return invoke(() => undefined);
    }

    // Any other run opens a store and a trace of its own, whatever store it
    // starts in. A trace id there is no proof that an operation is still open
    // around the run: a store outlives its operation in whatever the
    // operation left running - the timer chain of a cron job a request
    // rescheduled, a Redis connection a request opened - and a run read as
    // nested in it used to run in an id-less store, unreported, with
    // `TracerService.createSpan()` throwing in its handler.
    //
    // The same map `run` is given, rather than `getStore()` inside the
    // callback: identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    if (activeJob) {
      store.set(ACTIVE_JOB_KEY as KeyOf<Store>, activeJob);
    }
    return this.asyncLocalStorage.run(store, () => {
      // The registry key is always this run's own. The inherited id may belong
      // to a request still open in this process, and a retry reuses it.
      const registryKey = uuidv7();
      const inheritedTraceId = this.readInheritedTraceId(job.opts);
      const traceId = inheritedTraceId ?? registryKey;
      store.set(this.options.traceIdKey, traceId);
      store.set(TRACE_REGISTRY_KEY as KeyOf<Store>, registryKey);
      // Ended as the run settles, recorded or not: see `liveTraceId`.
      const operation = openOperation(store);

      // With OpenTelemetry interop on, the job runs in the W3C trace context
      // it was enqueued in, for an OpenTelemetry SDK in this process - see
      // `continueHandedOnTrace`. Recorded or not, as an outbound call carries
      // the trace on for an unrecorded request.
      const handedOn =
        inheritedTraceId !== undefined && this.openTelemetryInteropOn()
          ? job.opts?.[JOB_TRACE_CONTEXT_OPTION_KEY]
          : undefined;
      // And the job's span goes under the span that handed it on, for `otlp`,
      // while the calls it makes carry the caller's decision on - as a
      // request's do with the `traceparent` it arrived with.
      const traceContext = handedOnTraceContext(handedOn, traceId);
      if (traceContext) {
        store.set(TRACE_CONTEXT_KEY, traceContext);
      }

      const context: JobContext = {
        queueName: job.queueName,
        name: job.name,
        id: typeof job.id === "number" ? `${job.id}` : job.id,
      };

      setAttributesSafely(
        this.options.jobs?.setAttributes,
        [context],
        this.options.jobs,
        store,
        this.logger,
        "jobs",
      );

      if (this.isIgnored(context)) {
        // The trace id stays in the store so logs and jobs enqueued from here
        // still correlate; nothing is registered under the registry key, so
        // its spans have no trace to join.
        const end = () => endOperation(operation);
        let result: T;
        try {
          result =
            handedOn === undefined
              ? invoke(end)
              : continueHandedOnTrace(handedOn, traceId, () => invoke(end));
        } catch (error) {
          end();
          throw error;
        }
        if (!settlesItself) {
          // Its driver takes the promise as the outcome and consumes it, so
          // watching it here changes nothing about how a rejection surfaces.
          if (result instanceof Promise) {
            result.then(end, end);
          } else {
            end();
          }
        }
        return result;
      }

      this.operationTraceRegistry.startTrace(
        registryKey,
        {
          tags: this.options.jobs?.tags,
          ...context,
          ...job.metadata,
        } as JobSnapshot,
        traceId,
        traceContext,
      );

      let outcome: JobStatus | undefined;
      // The promise a callback-style handler returned, which its driver
      // drops - see where it is handed back, below.
      let dropped: Promise<unknown> | undefined;
      const settle = (status: JobStatus) => {
        if (outcome) {
          return;
        }
        outcome = status;
        endOperation(operation);
        if (status === "failed") {
          dropped?.then(undefined, ignoreRejection);
        }
        deferTraceCompletion(
          async () => {
            this.operationTraceRegistry.endTrace(registryKey, { status });

            const snapshot = (await this.operationTraceRegistry.pluckSnapshot(
              registryKey,
            )) as JobSnapshot | undefined;

            // `pluckSnapshot` deletes what it returns, so a trace already
            // plucked answers undefined, and the encoder would dereference it
            // in this deferred completion, where no try/catch can reach: an
            // unhandled TypeError that took the whole process down.
            //
            // Dropped rather than reported: there is no snapshot, so there is
            // nothing to send, and losing one job's self-instrumentation is
            // not worth a crash loop.
            if (!snapshot) {
              return;
            }
            this.observeAgentSharedBuffer.insertJobSnapshot(snapshot);
          },
          this.logger,
          "job",
          () => this.operationTraceRegistry.hasOpenSpans(registryKey),
        );
      };

      try {
        const returnValue =
          handedOn === undefined
            ? invoke(settle)
            : continueHandedOnTrace(handedOn, traceId, () => invoke(settle));
        if (returnValue instanceof Promise) {
          // Handed back as the handler returned it, never as a promise
          // chained onto it: a chained promise has none of the members of the
          // handler's own (Bull calls `cancel()` on it when a job times out,
          // and hands it to `active` listeners), and it rejects on its own.
          if (settlesItself) {
            // Bull drops what a callback-style processor returns, and `done`
            // is the outcome. One that reports its failure through `done` and
            // returns the promise it handled that way -
            // `redis.hincrby(key, field, n, done)` - left a chained rejection
            // nobody listened to, and the `unhandledRejection` ended a worker
            // that carries on without the agent.
            //
            // So it is not watched either: watching marks it handled, and an
            // `async (job, done)` processor that throws before it calls
            // `done` has to raise `unhandledRejection` as it does without the
            // agent. Only once `done` has reported a failure is the rejection
            // marked handled: an instrumented provider's `@Process()` method
            // hands back a promise chained onto its method's, and that one
            // rejects again after the method's own was handled.
            dropped = returnValue;
            if (outcome === "failed") {
              returnValue.then(undefined, ignoreRejection);
            }
          } else {
            // A driver that takes the promise as the outcome consumes it, so
            // the run is settled from a side branch. Attached before the
            // driver's own reactions, it still settles the run first.
            returnValue.then(
              () => settle("completed"),
              () => settle("failed"),
            );
          }
          return returnValue;
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

/** Marks a rejection handled, where it has already been reported. */
function ignoreRejection(): void {}
