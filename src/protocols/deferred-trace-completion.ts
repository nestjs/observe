import type { Logger } from "@nestjs/common";
import {
  CALLER_METADATA_KEY,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OPERATION_STATE_KEY } from "../utils/operation-state.util.js";
import { SHARED_ATTRIBUTES_KEY } from "../utils/shared-attributes.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";

const reportedCallbacks = new WeakSet<Function>();
const reportedDeferredFailures = new WeakSet<object>();

function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an unprintable error";
  }
}

function warnSafely(logger: Logger, message: string): void {
  try {
    logger.warn(message);
  } catch {
    // Diagnostics must not become another failure in the operation traced -
    // or in its deferred telemetry.
  }
}

/**
 * Runs a callback from the module options, answering `fallback()` when it
 * throws. These callbacks only shape what is recorded, so a bug in one must
 * not fail the request, message or job being recorded - or, thrown from a
 * timer, end the process. The first failure of each callback is reported
 * with its error and `outcome`, what was given up for it; later ones are not.
 */
export function invokeUserCallbackSafely<
  TArgs extends unknown[],
  TResult,
  TFallback,
>(
  callback: (...args: TArgs) => TResult,
  args: TArgs,
  receiver: unknown,
  fallback: () => TFallback,
  logger: Logger,
  name: string,
  outcome: string,
): TResult | TFallback {
  try {
    return callback.apply(receiver, args);
  } catch (error) {
    reportCallbackFailure(callback, logger, name, "threw", outcome, error);
    return fallback();
  }
}

/**
 * Reports the first failure of a callback, whichever way it failed: a
 * callback that both throws and returns what cannot be used still says so
 * once.
 */
function reportCallbackFailure(
  callback: Function,
  logger: Logger,
  name: string,
  failure: string,
  outcome: string,
  error: unknown,
): void {
  if (reportedCallbacks.has(callback)) {
    return;
  }
  reportedCallbacks.add(callback);
  warnSafely(
    logger,
    `"${name}" ${failure}; ${outcome}. Later failures are not reported: ${describeFailure(error)}`,
  );
}

/**
 * The trace id for an operation. A generator that throws is replaced by a
 * fresh uuidv7, which no open trace can share, so the operation is still
 * traced under a registry key of its own.
 */
export function generateTraceIdSafely(
  generator: (context: unknown) => string,
  context: unknown,
  receiver: unknown,
  logger: Logger,
): string {
  return invokeUserCallbackSafely(
    generator,
    [context],
    receiver,
    uuidv7,
    logger,
    "traceIdGenerator",
    "using a random trace id",
  );
}

/**
 * What the agent keeps in an operation's store for itself, beside the trace
 * id under `traceIdKey`. Attributes share that store, and their names can
 * come from a sender - a message's metadata, a query string spread into the
 * result - so one named like any of these is left out rather than written
 * over the agent's own entry. A trace id that arrived that way had been
 * through none of the checks an `x-request-id` goes through, and was sent on
 * to every service called downstream; a registry key or a caller that
 * arrived that way detached the operation from its trace.
 */
const AGENT_STORE_KEYS: ReadonlySet<string> = new Set([
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
  TRACE_CONTEXT_KEY,
  OPERATION_STATE_KEY,
]);

const reportedReservedKeys = new WeakSet<Function>();

/**
 * Copies an operation's `setAttributes` into its store, unless it throws.
 *
 * An attribute named `traceIdKey`, or like one of `AGENT_STORE_KEYS`, is left
 * out: the store keeps the agent's own entry there. The first such key each
 * callback returns is reported; later ones are not.
 */
export function setAttributesSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => Record<string, unknown>) | undefined,
  args: TArgs,
  receiver: unknown,
  store: Map<any, unknown>,
  logger: Logger,
  transport: string,
  traceIdKey: string,
): void {
  if (!callback) {
    return;
  }
  const attributes = invokeUserCallbackSafely(
    callback,
    args,
    receiver,
    () => undefined,
    logger,
    `${transport}.setAttributes`,
    "continuing without its attributes",
  );
  if (!attributes) {
    return;
  }
  // Over what `TracerService.setAttribute` set earlier in the operation as
  // well, where it set anything: `getAttribute` reads that first, and the
  // later write is the one it should return - GraphQL's, in a request whose
  // middleware set the same key.
  const shared = store.get(SHARED_ATTRIBUTES_KEY) as
    | Map<unknown, unknown>
    | undefined;
  for (const [key, value] of Object.entries(attributes)) {
    if (key === traceIdKey || AGENT_STORE_KEYS.has(key)) {
      if (!reportedReservedKeys.has(callback)) {
        reportedReservedKeys.add(callback);
        warnSafely(
          logger,
          `"${transport}.setAttributes" returned an attribute named "${key.slice(0, 100)}", a key the agent keeps for itself; it is left out. Later ones are not reported.`,
        );
      }
      continue;
    }
    store.set(key, value);
    shared?.set(key, value);
  }
}

/**
 * Whether `ignore` excludes an operation. One that throws excludes it as
 * well: the operation still runs, but recording what a broken predicate may
 * have been written to keep out is not a safe guess.
 */
export function shouldIgnoreSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => boolean) | undefined,
  args: TArgs,
  receiver: unknown,
  logger: Logger,
  transport: string,
): boolean {
  if (!callback) {
    return false;
  }
  return invokeUserCallbackSafely(
    callback,
    args,
    receiver,
    () => true,
    logger,
    `${transport}.ignore`,
    "not tracing the operation",
  );
}

/**
 * A bad identity callback must not prevent the trace from being closed.
 *
 * Made a string here, inside the guard, rather than by whoever records it: a
 * callback typed to return a string can still hand back what a message
 * carried - a TCP packet's metadata is whatever `JSON.parse` made of it - and
 * `String()` throws on `{"toString": 1}`. Thrown between ending the trace and
 * plucking it, that left the trace registered for the life of the process.
 */
export function getUserIdSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => string | undefined) | undefined,
  args: TArgs,
  receiver: unknown,
  logger: Logger,
  transport: string,
): string | undefined {
  if (!callback) {
    return undefined;
  }
  const name = `${transport}.getUserId`;
  const outcome = "completing the trace without a user id";
  const userId: unknown = invokeUserCallbackSafely(
    callback,
    args,
    receiver,
    () => undefined,
    logger,
    name,
    outcome,
  );
  if (userId === undefined || typeof userId === "string") {
    return userId;
  }
  try {
    // oxlint-disable-next-line typescript/no-base-to-string -- recorded as `String()` always recorded it
    return String(userId);
  } catch (error) {
    reportCallbackFailure(
      callback,
      logger,
      name,
      "returned a value that cannot be made a string",
      outcome,
      error,
    );
    return undefined;
  }
}

/**
 * Completes a trace once its operation has ended, without ever leaking a
 * rejection from the completion.
 *
 * Right away - in a microtask, once the rest of the listeners of the event
 * that ended the operation have run - when `hasOpenSpans` says every span of
 * the trace has closed, which is the usual case: spans close as the handler's
 * calls return. Otherwise on a timer, so that a span still closing has that
 * moment to end before the trace is plucked. A timer for every operation cost
 * a lightly loaded process a wake-up of its event loop per request, about
 * 35 µs of CPU each on a laptop, and a busy one nothing it would notice.
 */
export function deferTraceCompletion(
  completion: () => Promise<void>,
  logger: Logger,
  transport: string,
  hasOpenSpans?: () => boolean,
): void {
  const complete = () => {
    void Promise.resolve()
      .then(completion)
      .catch((error: unknown) => {
        if (!reportedDeferredFailures.has(logger)) {
          reportedDeferredFailures.add(logger);
          warnSafely(
            logger,
            `Deferred ${transport} trace completion failed; later failures are not reported: ${describeFailure(error)}`,
          );
        }
      });
  };
  if (!hasOpenSpans) {
    setTimeout(complete, 0);
    return;
  }
  queueMicrotask(() => {
    if (hasOpenSpans()) {
      setTimeout(complete, 0);
    } else {
      complete();
    }
  });
}
