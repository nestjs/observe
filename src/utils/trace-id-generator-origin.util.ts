import { defaultTraceIdGenerator } from "./default-trace-id-generator.util.js";

/**
 * Whether the module's `traceIdGenerator` is `defaultTraceIdGenerator`,
 * recorded on its options by `createObserveModule` while they are still a
 * plain object.
 *
 * Read back rather than found by comparing the function: Nest hands the
 * options out instrumented like any provider, and a function read off them is
 * a wrapper, never equal to the one stored. A boolean comes through as it is.
 */
const USES_DEFAULT_TRACE_ID_GENERATOR = Symbol("usesDefaultTraceIdGenerator");

/** Records whether `options` holds the default generator - see above. */
export function recordTraceIdGeneratorOrigin(options: {
  traceIdGenerator?: (req: unknown) => string;
}): void {
  (options as Record<symbol, unknown>)[USES_DEFAULT_TRACE_ID_GENERATOR] =
    options.traceIdGenerator === defaultTraceIdGenerator;
}

/**
 * Whether the options hold the default generator, which `openTelemetry`
 * swaps for `openTelemetryTraceIdGenerator` while interop runs. Options
 * `createObserveModule` never saw read as a generator of the application's
 * own, which is left alone.
 */
export function usesDefaultTraceIdGenerator(options: object): boolean {
  return (
    (options as Record<symbol, unknown>)[USES_DEFAULT_TRACE_ID_GENERATOR] ===
    true
  );
}
