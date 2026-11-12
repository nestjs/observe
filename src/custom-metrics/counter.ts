import { CustomMetric } from "../interfaces/custom-metric.interface.js";
import { admitsFinite, admitsReading } from "./finite-value.util.js";
import {
  admitsLabelValues,
  isLabelSet,
  MAX_SERIES_KEY_LENGTH,
} from "./label-values.util.js";

const DEFAULT_LABEL = "default" as const;

/**
 * Serialises a label object into the map key that identifies its series.
 *
 * Keys are sorted first: `JSON.stringify` preserves insertion order, so
 * `{ route, method }` and `{ method, route }` would otherwise be two different
 * series for what is the same label set.
 */
export function stringifyLabel(label: Record<string, string | number>): string {
  const sorted: Record<string, string | number> = {};
  for (const key of Object.keys(label).sort()) {
    sorted[key] = label[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Distinct label combinations one metric may hold.
 *
 * Counters and gauges are cumulative: a series, once created, is kept and
 * flushed for the life of the process. That is correct for a counter and fatal
 * for one labelled with something unbounded - a user id, a request id, a raw
 * URL - which grows this object forever inside the *host application's* memory
 * and adds a row per series to every flush. A summary's labels go when its
 * window does, on each flush written - but a flush that is never written, by
 * an agent switched off or without credentials, never clears one, so a
 * summary that declared no labels is held to the same number per window.
 *
 * A thousand is far above a sensible label set and far below a leak.
 */
export const MAX_SERIES_PER_METRIC = 1_000;

/**
 * Whether a metric may record under `key`: a series it already has, or a new
 * one that is within the cap and short enough for the collector.
 *
 * Refuses rather than throws. This runs inside a customer's own code path -
 * `counter.increment({ userId })` in the middle of their request handler - and
 * an agent that crashes the application it is measuring is worse than one that
 * drops a series. The first refusal of each kind is logged, once per metric,
 * because a silent cap is indistinguishable from a metric that does not work.
 */
export function admitsSeries(
  metricName: string,
  values: Record<string, unknown>,
  key: string,
  state: { warned: boolean; longKeyWarned?: boolean },
): boolean {
  if (key in values) {
    return true;
  }

  if (key.length > MAX_SERIES_KEY_LENGTH) {
    if (!state.longKeyWarned) {
      state.longKeyWarned = true;
      console.warn(
        `[observe] Metric "${metricName}" ignored a label combination of ${key.length} characters; ` +
          `the collector accepts at most ${MAX_SERIES_KEY_LENGTH} and refuses the whole batch over a longer one. ` +
          `Shorter label values - an id rather than a URL, say - keep recording.`,
      );
    }
    return false;
  }

  // `warned` doubles as a "cap reached" latch: series are never removed, so
  // once the cap has been observed it cannot un-reach. Counting keys is O(n),
  // and without the latch every rejected call would pay it - and the rejected
  // calls are exactly the unbounded-label hot path this cap exists to survive.
  if (!state.warned) {
    if (Object.keys(values).length < MAX_SERIES_PER_METRIC) {
      return true;
    }
    state.warned = true;
    console.warn(
      `[observe] Metric "${metricName}" reached ${MAX_SERIES_PER_METRIC} distinct label combinations; ` +
        `further label values are being ignored. This usually means a label carries something unbounded ` +
        `(a user id, a request id, a URL). Existing series keep recording.`,
    );
  }
  return false;
}

export class Counter<TLabel extends string = typeof DEFAULT_LABEL>
  implements CustomMetric<TLabel>
{
  /**
   * Whether the series cap has already been reported. An object rather than a
   * bare field so `admitsSeries` can set it - a `private` member is not
   * assignable to the structural type such a helper can name.
   */
  private readonly seriesLimit = { warned: false };

  /** Whether a non-finite value has already been reported, likewise. */
  private readonly nonFinite = { warned: false };

  /** Whether a label value no key can be made from has been reported. */
  private readonly labelValues = { warned: false };

  /**
   * The name of the counter.
   * This should be a descriptive name that identifies the counter.
   * For example, "user_login_count" or "api_request_count".
   */
  readonly name: string;

  /**
   * The type of the custom metric.
   * This is always 'counter' for this class.
   * It indicates that this metric is a counter that can be incremented.
   */
  readonly type: "counter";

  /**
   * A brief description of the counter's purpose.
   * This can be used to provide additional context about what the counter represents.
   * For example, "Number of user logins in the last hour" or "Total API requests received".
   */
  readonly description?: string;

  /**
   * The value of the counter.
   */
  readonly value: Record<string, number>;

  /**
   * Optional labels for the counter.
   * Labels are key-value pairs that can be used to add additional context to the counter.
   * For example, you might use labels to indicate the environment (e.g., "production", "development") or the service (e.g., "user-service", "order-service").
   */
  readonly labels?: TLabel[];

  private _tags?: Record<string, string>;
  private _onChange?: (self: Counter<TLabel>) => void;
  private _initialValue: number = 0;
  private _lastUpdated: number = Date.now();
  private _lastFlushedValue: Record<string, number> = {};

  /**
   * How much each label rose since the last successful flush.
   *
   * Reported alongside the cumulative `value` so the backend has an additive
   * quantity to aggregate. Summing cumulative readings double counts, and a
   * process restart resets `value` to zero, which makes a naive
   * difference-on-read undercount - this is measured in-process, so neither
   * problem applies.
   */
  get increase(): Record<string, number> {
    const increase: Record<string, number> = {};
    for (const [label, current] of Object.entries(this.value)) {
      increase[label] = current - (this._lastFlushedValue[label] ?? 0);
    }
    return increase;
  }

  /**
   * Marks the current cumulative values as reported.
   *
   * Called by the agent only once a flush has actually been written, so a failed
   * flush leaves the baseline untouched and the increase rolls into the next one
   * instead of being lost.
   */
  markFlushed(): void {
    this._lastFlushedValue = { ...this.value };
  }

  /**
   * Gets the timestamp of when the counter was last updated.
   * This is a Unix timestamp in milliseconds.
   * @returns The last updated timestamp.
   */
  get lastUpdated(): number {
    return this._lastUpdated;
  }

  /**
   * Gets tags associated with the counter.
   * Tags are key-value pairs that provide additional context about the counter.
   * @returns An object containing tags, or undefined if no tags are set.
   */
  get tags(): Record<string, string> | undefined {
    return this._tags;
  }

  /**
   * Sets tags for the counter.
   * Tags are key-value pairs that provide additional context about the counter.
   * @param tags An object containing tags to set.
   */
  set tags(tags: Record<string, string> | undefined) {
    if (tags && typeof tags !== "object") {
      throw new Error("Tags must be an object with key-value pairs.");
    }
    this._tags = tags;
  }

  constructor(name: string);
  constructor(name: string, description: string);
  constructor(name: string, description: string, initialValue: number);
  constructor(name: string, description: string, labels: TLabel[]);
  constructor(
    name: string,
    description: string,
    initialValue: number,
    labels: TLabel[],
  );
  /**
   * The form `TracerService.counter()` builds when it spreads an attributes
   * bag, where any member may be absent. Listed last so the overloads above
   * stay the ones a hand-written call resolves to.
   */
  constructor(
    name: string,
    description?: string,
    initialValue?: number,
    labels?: TLabel[],
  );
  constructor(
    name: string,
    description?: string,
    labelsOrInitialValue?: TLabel[] | number,
    labels?: TLabel[],
  ) {
    this.name = name;
    this.description = description;
    this.type = "counter";

    const initialValue =
      typeof labelsOrInitialValue === "number" ? labelsOrInitialValue : 0;
    // Every series starts from this, so a non-finite one is replaced rather
    // than poisoning all of them.
    this._initialValue = admitsFinite(name, initialValue, this.nonFinite)
      ? initialValue
      : 0;
    if (Array.isArray(labelsOrInitialValue)) {
      this.labels = labelsOrInitialValue;
      this.value = {};
    } else if (labels) {
      this.labels = labels;
      this.value = {};
    } else {
      this.value = {
        [DEFAULT_LABEL]: this._initialValue,
      };
    }
  }

  /**
   * Gets the current value of the counter.
   * If labels are defined, you must specify a label to get the value for that label.
   * If no label is specified, it returns the value for the default label.
   * @returns The current value of the counter.
   */
  getValue(): number;
  /**
   * Gets the current value of the counter.
   * If labels are defined, you must specify a label to get the value for that label.
   * If no label is specified, it returns the value for the default label.
   * @param label Optional label to get the value for. If not provided, returns the default value.
   * @returns The current value of the counter.
   */
  getValue(label: Record<TLabel, string | number>): number;
  getValue(label?: Record<TLabel, string | number>): number {
    if (this.labels && !label) {
      throw new Error(
        "Cannot get value of a counter with labels without specifying a label. For example, use `counter.getValue({ route: '/login' })`.",
      );
    } else if (this.labels && label) {
      this.validateLabels(label);

      const stringifiedLabel = stringifyLabel(label);
      // Presence, not truthiness: a counter that has been incremented by 0, or
      // decremented back to it, still exists.
      if (!(stringifiedLabel in this.value)) {
        throw new Error(
          `Label "${stringifiedLabel}" does not exist in the counter. Available labels: ${Object.keys(
            this.value,
          ).join(", ")}.`,
        );
      }

      return this.value[stringifiedLabel];
    } else {
      return this.value[DEFAULT_LABEL];
    }
  }

  /**
   * Increments the counter by a specified value.
   * If no value is provided, it defaults to 1.
   */
  increment(): void;
  /**
   * Increments the counter by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to increment the counter for.
   */
  increment(label: Record<TLabel, string | number>): void;
  /**
   * Increments the counter by a specified value.
   * @param value Value to increment the counter by.
   */
  increment(value: number): void;
  /**
   * Increments the counter by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to increment the counter for.
   * @param value Value to increment the counter by.
   */
  increment(label: Record<TLabel, string | number>, value: number): void;
  increment(
    labelOrValue?: Record<TLabel, string | number> | number,
    value?: number,
  ): void {
    if (this.labels && !isLabelSet(labelOrValue)) {
      throw new Error(
        "Cannot increment a counter with labels without specifying a label. For example, use `counter.increment({ route: '/login' })`.",
      );
    }

    if (isLabelSet(labelOrValue)) {
      this.validateLabels(labelOrValue);
      if (!admitsLabelValues(this.name, labelOrValue, this.labelValues)) {
        return;
      }

      const stringifiedLabel = stringifyLabel(labelOrValue);
      const incrementValue = value ?? 1;
      if (!admitsFinite(this.name, incrementValue, this.nonFinite)) {
        return;
      }
      const reading =
        (this.value[stringifiedLabel] ?? this._initialValue) + incrementValue;
      if (
        !this.admitsNewReading(stringifiedLabel, reading) ||
        !admitsSeries(this.name, this.value, stringifiedLabel, this.seriesLimit)
      ) {
        return;
      }
      this.value[stringifiedLabel] = reading;
    } else {
      const incrementValue = labelOrValue ?? 1;
      if (!admitsFinite(this.name, incrementValue, this.nonFinite)) {
        return;
      }
      const reading =
        (this.value[DEFAULT_LABEL] ?? this._initialValue) + incrementValue;
      if (!this.admitsNewReading(DEFAULT_LABEL, reading)) {
        return;
      }
      this.value[DEFAULT_LABEL] = reading;
    }
    this._lastUpdated = Date.now();

    if (this._onChange) {
      this._onChange(this);
    }
  }

  /**
   * Whether `key` may move to `reading`. The reading and its increase since
   * the last flush both go on the wire, and the increase can leave the
   * doubles while the reading stays in them: a counter taken down to -1e308,
   * flushed, then brought back up to 1e308 is 2e308 above its baseline.
   */
  private admitsNewReading(key: string, reading: number): boolean {
    return admitsReading(
      this.name,
      reading,
      this.nonFinite,
      this._lastFlushedValue[key] ?? 0,
    );
  }

  private validateLabels(labeledValue: Record<TLabel, string | number>): void {
    const keys = Object.keys(labeledValue);
    const declared = this.labels;
    declared?.forEach((label) => {
      if (!keys.includes(label)) {
        throw new Error(
          `Label "${label}" is not defined in the counter. Available labels: ${declared.join(
            ", ",
          )}.`,
        );
      }
    });
  }
}
