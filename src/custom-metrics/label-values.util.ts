/**
 * The longest series key - the serialised label combination - the collector
 * accepts. A longer one is not truncated there: the whole batch it rides in is
 * refused, logs and spans included. The longest label it accepts, too, which
 * is what a summary keys its series by.
 */
export const MAX_SERIES_KEY_LENGTH = 255;

/**
 * Whether a series key can be made from a label set's values, checked before
 * it is made.
 *
 * A label value is a string or a number - a boolean or a null keys as well -
 * but a handler that passes a field of a JSON body on unchecked can hand a
 * metric anything JSON parses to. Made into a key, an array nested a few
 * thousand levels deep overflowed the stack and a bigint threw a TypeError,
 * out of the metric call and into the request being measured. An object or
 * an array is refused whatever its depth: no label set is meant to hold one.
 * Refuses rather than throws, for the reason `admitsSeries` gives, and says
 * so once per metric.
 */
export function admitsLabelValues(
  metricName: string,
  label: object,
  state: { warned: boolean },
): boolean {
  for (const name in label) {
    const value: unknown = (label as Record<string, unknown>)[name];
    if (
      (typeof value === "object" && value !== null) ||
      typeof value === "bigint"
    ) {
      if (!state.warned) {
        state.warned = true;
        console.warn(
          `[observe] Metric "${metricName}" ignored a label set holding a value of type ${typeof value}; ` +
            `label values are strings or numbers. Further ones are ignored without another warning.`,
        );
      }
      return false;
    }
  }
  return true;
}

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
