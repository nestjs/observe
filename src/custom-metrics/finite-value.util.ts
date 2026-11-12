/**
 * Whether a metric may record `value`, once any default has been applied.
 *
 * Refuses rather than throws, for the reason `admitsSeries` gives: a metric
 * call runs inside the application's own code path. A NaN or an Infinity is
 * nearly always computed from the application's own data - a division by a
 * total that was zero, a value that failed to parse - so it turns up on
 * unlucky input in production rather than on every run. Recorded, it would
 * reach the collector as null, and a counter would stay NaN for the rest of
 * the process. The first refusal is logged, once per metric.
 *
 * Callers check it after their own argument checks, so a mistake in the
 * calling code - a missing label - still throws, on every run.
 *
 * Kept out of `counter.ts`, unlike `admitsSeries`: everything that module
 * exports is re-exported from the package root.
 */
export function admitsFinite(
  metricName: string,
  value: number,
  state: { warned: boolean },
): boolean {
  if (Number.isFinite(value)) {
    return true;
  }

  if (!state.warned) {
    state.warned = true;
    // Only what the warning is about - a NaN, an Infinity, a missing value -
    // is printed. Anything else got past the type at run time, a field of a
    // request body say, and need not convert to a string at all: `{"toString":
    // 1}` throws a TypeError and a deeply nested array a RangeError, out of
    // the call this function exists not to fail. Nor is a string any
    // particular length, or free of line breaks.
    const refused: unknown = value;
    const given =
      typeof refused === "number" || refused === undefined || refused === null
        ? String(refused)
        : `a value of type ${typeof refused}`;
    console.warn(
      `[observe] Metric "${metricName}" ignored ${given}, which is not a finite number. ` +
        `Further ones are ignored without another warning. This usually means the value is ` +
        `computed from something that can be zero or missing (a division by a zero total, a failed parse).`,
    );
  }
  return false;
}
