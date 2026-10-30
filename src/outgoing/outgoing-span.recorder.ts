import { AsyncLocalStorage } from "async_hooks";
import {
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";

type Tags = Record<string, string | number | boolean>;

/**
 * How long a held span may stay open after its call ended, waiting for what
 * is reading its response. Well under the second the registry waits for open
 * spans before it ships an operation without them.
 */
const HOLD_GRACE_MS = 250;

/** A span that has been opened and is waiting to be told how the call went. */
export interface OpenOutgoingSpan {
  /**
   * The span's id, for a call that names its span to the service it calls -
   * the parent id of an outbound `traceparent`.
   */
  readonly spanId: string;
  end(error?: unknown): void;
  /** Adds tags to the span - what the response said, once it has been read. */
  tag?(tags: Tags): void;
  /**
   * Keeps the span from closing at `end` until the returned function runs,
   * so tags read from the response can still reach it. The span keeps the
   * duration it had at `end`, and closes on its own `HOLD_GRACE_MS` later if
   * the hold is never released.
   */
  hold?(): () => void;
}

/**
 * Opens leaf spans for calls that leave the process - a database query, an
 * outbound HTTP request - under whatever span is active when they are made.
 *
 * These calls never pass through the instance decorator: a driver is not a
 * Nest provider, and an ORM's repository is only the last class the
 * application can see before the time disappears. Each driver integration
 * reads its own arguments and then uses this to put the span in the tree the
 * same way the decorator would, so the waterfall shows a query under the
 * repository method that ran it.
 *
 * A plain class shared by the integrations rather than a provider, and
 * deliberately free of anything driver-specific.
 */
export class OutgoingSpanRecorder {
  /**
   * Set while a higher-level entry point (a pool's `query`) already holds the
   * span for a call, so the lower-level one it delegates to (the client's
   * `query`) does not open a second.
   */
  private readonly covered = new AsyncLocalStorage<true>();

  constructor(
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly asyncLocalStorage: AsyncLocalStorage<Map<any, any>>,
    private readonly traceIdKey: string,
  ) {}

  /**
   * Opens a span, or returns `undefined` when there is nothing to attach it
   * to: no traced operation in this async context, one that was sampled out,
   * or a call an outer entry point already covers.
   */
  open(
    className: string,
    methodKey: string,
    tags: Tags,
    /**
     * The id to open the span under, minted by a caller that had to name the
     * span before it could open it. A fresh one otherwise.
     */
    presetSpanId?: string,
  ): OpenOutgoingSpan | undefined {
    if (this.covered.getStore()) {
      return undefined;
    }
    const store = this.asyncLocalStorage.getStore();
    const registryKey =
      store?.get(TRACE_REGISTRY_KEY) ?? store?.get(this.traceIdKey);
    if (typeof registryKey !== "string") {
      return undefined;
    }
    const callerId = store?.get(CALLER_METADATA_KEY) as string | undefined;
    const spanId = this.operationTraceRegistry.internalStartTraceStep(
      registryKey,
      className,
      methodKey,
      callerId,
      presetSpanId,
    );
    if (spanId === undefined) {
      return undefined;
    }
    const node = this.operationTraceRegistry.getActiveSpan(registryKey, spanId);
    if (node) {
      node.tags = { ...node.tags, ...tags };
    }
    const startTime = node?.startTime;

    let ended = false;
    let holds = 0;
    let deferred: { at: number; error?: unknown } | undefined;
    let grace: NodeJS.Timeout | undefined;
    const close = (error?: unknown, endedAt?: number) => {
      // A driver may report one call twice - a callback and an `error`
      // event, a settled promise and a late listener. The registry counts
      // closes against opens, so the second would unbalance the snapshot.
      if (ended) {
        return;
      }
      ended = true;
      clearTimeout(grace);
      this.operationTraceRegistry.internalEndTraceStep(
        registryKey,
        spanId,
        className,
        methodKey,
        spanId,
        error === undefined || error === null ? undefined : (error as Error),
      );
      // A held span closes late; the call itself ended at `endedAt`.
      if (node && endedAt !== undefined && startTime !== undefined) {
        (node as unknown as { duration: number }).duration = Math.max(
          endedAt - startTime,
          0,
        );
      }
    };
    return {
      spanId,
      end: (error?: unknown) => {
        if (ended || deferred) {
          return;
        }
        if (holds === 0) {
          close(error);
          return;
        }
        deferred = { at: performance.now(), error };
        grace = setTimeout(
          () => close(deferred?.error, deferred?.at),
          HOLD_GRACE_MS,
        );
        grace.unref?.();
      },
      tag: (extra: Tags) => {
        if (node) {
          node.tags = { ...node.tags, ...extra };
        }
      },
      hold: () => {
        if (ended) {
          return () => undefined;
        }
        holds += 1;
        let released = false;
        return () => {
          if (released) {
            return;
          }
          released = true;
          holds -= 1;
          if (holds === 0 && deferred) {
            close(deferred.error, deferred.at);
          }
        };
      },
    };
  }

  /**
   * Whether `open` would attach a span here - asked first by an integration
   * whose description of a call costs more than the call's own bookkeeping
   * (a statement it has to tokenize), so that untraced and sampled-out calls
   * do not pay for a description nobody will read.
   */
  isRecording(): boolean {
    if (this.covered.getStore()) {
      return false;
    }
    const store = this.asyncLocalStorage.getStore();
    const registryKey =
      store?.get(TRACE_REGISTRY_KEY) ?? store?.get(this.traceIdKey);
    return (
      typeof registryKey === "string" &&
      this.operationTraceRegistry.hasTrace(registryKey)
    );
  }

  /** Runs `fn` with nested entry points told the call is already covered. */
  cover<T>(fn: () => T): T {
    return this.covered.run(true, fn);
  }

  /**
   * Ends `span` when `result` settles, and hands `result` back untouched - the
   * caller's own chain must see the same value and the same rejection it
   * would have without the span.
   *
   * Anything that is not thenable ends the span on the spot. An open span is
   * not harmless: the registry waits for every span to close before it ships
   * a snapshot, and gives the whole snapshot up when one never does - so an
   * unrecognised return type must cost this span its duration, not the
   * request its trace.
   */
  endWhenSettled<T>(span: OpenOutgoingSpan, result: T): T {
    const then = (result as { then?: unknown } | null | undefined)?.then;
    if (typeof then === "function") {
      (then as PromiseLike<unknown>["then"]).call(
        result,
        () => span.end(),
        (error: unknown) => span.end(error),
      );
    } else {
      span.end();
    }
    return result;
  }
}
