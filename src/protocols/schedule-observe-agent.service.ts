import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  JobContext,
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

/**
 * `@nestjs/schedule`'s metadata keys and scheduler-type enum, inlined so the
 * package stays an optional peer. `@Cron`/`@Interval`/`@Timeout` stamp all
 * three onto the handler: which kind of scheduler it is, the name it was given
 * (if any), and the options the decorator was called with.
 */
const SCHEDULER_TYPE = "SCHEDULER_TYPE";
const SCHEDULER_NAME = "SCHEDULER_NAME";
const SCHEDULE_CRON_OPTIONS = "SCHEDULE_CRON_OPTIONS";

/** `SchedulerType` from `@nestjs/schedule`, by value. */
const SCHEDULER_TYPE_LABELS: Record<number, string> = {
  1: "cron",
  2: "timeout",
  3: "interval",
};

/** The `ScheduleExplorer` surface this service patches, structurally typed. */
interface ScheduleExplorerLike {
  prototype?: {
    wrapFunctionInTryCatchBlocks?: WrapFunction;
  };
}

type ScheduledHandler = (...args: unknown[]) => unknown;
type WrapFunction = (
  this: unknown,
  methodRef: ScheduledHandler,
  instance: object,
) => ScheduledHandler;

/**
 * Scheduled job instrumentation for `@nestjs/schedule`.
 *
 * A `@Cron`, `@Interval` or `@Timeout` handler fires from a timer, so no
 * request ever reaches it and none of the protocol agents see it run. Left
 * alone, a nightly job that takes twenty minutes or fails every other night is
 * invisible: the instance decorator only records spans inside a trace, and
 * nothing opened one.
 *
 * `ScheduleExplorer` routes every handler it discovers through
 * `wrapFunctionInTryCatchBlocks(methodRef, instance)` before registering it
 * with the orchestrator - one seam that covers all three decorators. It is
 * patched on the prototype from this constructor, which Nest runs while it is
 * still instantiating providers and therefore strictly before any
 * `onModuleInit`, including the explorer's own, where discovery happens. The
 * explorer's wrapper is kept and ours goes inside it, so a throwing handler is
 * still logged by the scheduler exactly as before - it is just also reported.
 *
 * Each execution is reported as a job snapshot, the same shape BullMQ jobs
 * use: the scheduler type stands in for the queue name and the handler for the
 * job name, so `cron / ReportsService.nightly` sits alongside
 * `emails / send-welcome` in the same view.
 */
@Injectable()
export class ScheduleObserveAgentService<
  Store extends Record<string, unknown>,
> {
  private readonly logger = new Logger(ScheduleObserveAgentService.name);

  constructor(
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
  ) {
    this.patchScheduleExplorer();
  }

  /**
   * Loads the explorer without a static import, so a service that schedules
   * nothing need not install the package. Loaded from the constructor because
   * a dynamic `import()` would resolve after provider instantiation, with no
   * guarantee of landing before the explorer's `onModuleInit` has already
   * wrapped every handler.
   */
  private loadScheduleExplorer(): ScheduleExplorerLike | undefined {
    type ExplorerModule = { ScheduleExplorer?: ScheduleExplorerLike };

    // The entry point is the supported source, but it only re-exports the
    // explorer from 12.0.1 onwards; every earlier version keeps it behind a
    // deep path. Try the public export first, then the file, so a supported
    // import is preferred wherever one exists.
    const entryPoint = loadOptionalPeer<ExplorerModule>("@nestjs/schedule");
    if (!entryPoint.installed) {
      // Nothing scheduled, nothing to patch, and that is not a
      // misconfiguration.
      return undefined;
    }
    if (entryPoint.module?.ScheduleExplorer) {
      return entryPoint.module.ScheduleExplorer;
    }

    const deepPath = loadOptionalPeer<ExplorerModule>(
      "@nestjs/schedule",
      "@nestjs/schedule/dist/schedule.explorer.js",
    );
    if (deepPath.installed && deepPath.module?.ScheduleExplorer) {
      return deepPath.module.ScheduleExplorer;
    }

    // Installed, but the explorer is in neither place - a version that moved
    // it, say. Worth saying out loud, with whichever cause was recorded: the
    // symptom otherwise is a service whose jobs silently never appear.
    const cause =
      (deepPath.installed && deepPath.error) ||
      entryPoint.error ||
      new Error("ScheduleExplorer is not exported by @nestjs/schedule");
    this.logger.warn(
      `@nestjs/schedule is installed but its ScheduleExplorer could not be loaded, so scheduled jobs will not be instrumented: ${describePeerLoadError(cause)}`,
    );
    return undefined;
  }

  private patchScheduleExplorer(): void {
    const ScheduleExplorer = this.loadScheduleExplorer();
    if (!ScheduleExplorer) {
      return;
    }

    const prototype = ScheduleExplorer.prototype;
    const originalWrap = prototype?.wrapFunctionInTryCatchBlocks;
    if (typeof originalWrap !== "function") {
      // Installed, but shaped differently from every version this was written
      // against. Worth saying out loud: the symptom otherwise is a service
      // whose jobs silently never appear.
      this.logger.warn(
        "The installed version of @nestjs/schedule does not expose 'ScheduleExplorer.wrapFunctionInTryCatchBlocks', so scheduled jobs cannot be instrumented. Skipping patching.",
      );
      return;
    }

    // Re-entrant patching (a second `createObserveModule()` in the same
    // process, tests included) must not nest one wrapper inside another.
    const PATCHED = Symbol.for("@nestjs/observe:schedule-patched");
    const marked = originalWrap as WrapFunction & { [PATCHED]?: true };
    if (marked[PATCHED]) {
      return;
    }

    const instrument = (methodRef: ScheduledHandler, instance: object) =>
      this.instrumentHandler(methodRef, instance);

    const patched: WrapFunction & { [PATCHED]?: true } = function (
      this: unknown,
      methodRef,
      instance,
    ) {
      return originalWrap.call(this, instrument(methodRef, instance), instance);
    };
    patched[PATCHED] = true;
    prototype!.wrapFunctionInTryCatchBlocks = patched;
  }

  /**
   * Labels one handler the way the dashboard groups jobs.
   *
   * Read off the handler rather than handed in: the explorer already resolved
   * the method, and the instance decorator copies reflect-metadata onto the
   * wrapper it returns, so the decorator's stamps are there either way.
   */
  private describeHandler(
    methodRef: ScheduledHandler,
    instance: object,
  ): Pick<JobSnapshot, "queueName" | "name"> {
    const schedulerType = Reflect.getMetadata(SCHEDULER_TYPE, methodRef) as
      | number
      | undefined;
    const cronOptions = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      methodRef,
    ) as { name?: string } | undefined;
    const explicitName =
      (Reflect.getMetadata(SCHEDULER_NAME, methodRef) as string | undefined) ??
      cronOptions?.name;

    const className = instance?.constructor?.name || "Object";
    const methodName = methodRef.name || "anonymous";

    return {
      queueName:
        (schedulerType !== undefined && SCHEDULER_TYPE_LABELS[schedulerType]) ||
        "schedule",
      name: explicitName || `${className}.${methodName}`,
    };
  }

  private instrumentHandler(
    methodRef: ScheduledHandler,
    instance: object,
  ): ScheduledHandler {
    const { queueName, name } = this.describeHandler(methodRef, instance);

    return (...args: unknown[]) => {
      const hasOuterContext = this.asyncLocalStorage
        .getStore()
        ?.has(this.options.traceIdKey);

      const store = new Map<KeyOf<Store>, any>();
      return this.asyncLocalStorage.run(store, () => {
        if (hasOuterContext) {
          // Already inside a trace - a handler invoked by hand from a request,
          // say. The outer trace owns the spans; opening a second one would
          // report the same work twice.
          if (this.options.debug) {
            this.logger.debug(
              `Outer context already has a trace ID. Skipping inner context for scheduled job "${name}"`,
            );
          }
          return methodRef.call(instance, ...args);
        }

        const traceId = uuidv7();
        store.set(this.options.traceIdKey, traceId);

        // Every firing is its own job run, so every firing gets its own id.
        const id = uuidv7();
        const context: JobContext = { queueName, name, id };

        if (this.options.jobs?.setAttributes) {
          const attributes = this.options.jobs.setAttributes(context);
          if (attributes) {
            for (const [key, value] of Object.entries(attributes)) {
              store.set(key, value);
            }
          }
        }

        if (this.options.jobs?.ignore?.(context)) {
          // Still under a trace id of its own, so logs correlate; with no
          // trace started, its spans have nothing to join.
          return methodRef.call(instance, ...args);
        }

        this.operationTraceRegistry.startTrace(traceId, {
          tags: this.options.jobs?.tags,
          queueName,
          name,
          id,
        } as JobSnapshot);

        const endTrace = (status: JobSnapshot["status"]) => {
          setTimeout(async () => {
            this.operationTraceRegistry.endTrace(traceId, { status });

            const snapshot = (await this.operationTraceRegistry.pluckSnapshot(
              traceId,
            )) as JobSnapshot | undefined;

            // Absent when the registry discarded the trace - a handler on a
            // provider the instance decorator never wrapped records no spans,
            // and a trace with no spans is dropped rather than shipped empty.
            if (!snapshot) {
              return;
            }
            this.observeAgentSharedBuffer.insertJobSnapshot(snapshot);
          }, 0);
        };

        try {
          const returnValue = methodRef.call(instance, ...args);
          if (returnValue instanceof Promise) {
            return returnValue.then(
              (ret) => {
                endTrace("completed");
                return ret;
              },
              (error: unknown) => {
                endTrace("failed");
                // The explorer's own wrapper is outside this one and logs the
                // rejection as it always did.
                throw error;
              },
            );
          }

          endTrace("completed");
          return returnValue;
        } catch (error) {
          endTrace("failed");
          throw error;
        }
      });
    };
  }
}
