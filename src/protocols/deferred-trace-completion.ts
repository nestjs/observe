import type { Logger } from "@nestjs/common";
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
    if (!reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      warnSafely(
        logger,
        `"${name}" threw; ${outcome}. Later failures are not reported: ${describeFailure(error)}`,
      );
    }
    return fallback();
  }
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

/** Copies an operation's `setAttributes` into its store, unless it throws. */
export function setAttributesSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => Record<string, unknown>) | undefined,
  args: TArgs,
  receiver: unknown,
  store: Map<any, unknown>,
  logger: Logger,
  transport: string,
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
  for (const [key, value] of Object.entries(attributes)) {
    store.set(key, value);
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

/** A bad identity callback must not prevent the trace from being closed. */
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
  return invokeUserCallbackSafely(
    callback,
    args,
    receiver,
    () => undefined,
    logger,
    `${transport}.getUserId`,
    "completing the trace without a user id",
  );
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
