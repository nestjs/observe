/**
 * Whether the first argument of a counter's or a gauge's call is a label set
 * rather than the value.
 *
 * Not `typeof === "object"` alone, which a `null` passes: what a number field
 * of a JSON body holds when the client sent `null`, or when the sender
 * serialised a NaN. Taken for a label set, it threw from `Object.keys(null)`
 * into the request being measured; taken for the value, it is a missing one,
 * as `undefined` is.
 *
 * Kept out of `counter.ts`, for the reason `finite-value.util.ts` is: whatever
 * that module exports is re-exported from the package root.
 */
export function isLabelSet<TLabels extends object>(
  labelOrValue: TLabels | number | null | undefined,
): labelOrValue is TLabels {
  return typeof labelOrValue === "object" && labelOrValue !== null;
}
