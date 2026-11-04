import { CustomMetric } from "../interfaces/custom-metric.interface.js";
import { admitsSeries, stringifyLabel } from "./counter.js";
import { admitsFinite } from "./finite-value.util.js";

const DEFAULT_LABEL = "default" as const;

/**
 * Defines the kinds of gauges available.
 * - "additive": A gauge value will be summed up when multiple instances report values.
 * - "ratio": A gauge value represents a ratio and should be averaged across instances.
 * - "peak": A gauge value represents a peak measurement and the highest value should be reported.
 */
export type GaugeKind = "additive" | "ratio" | "peak";

export class Gauge<TLabel extends string = typeof DEFAULT_LABEL>
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

  /**
   * The name of the gauge.
   * This should be a descriptive name that identifies the gauge.
   * For example, "memory_usage" or "active_users".
   */
  readonly name: string;

  /**
   * The type of the custom metric.
   * This is always 'gauge' for this class.
   * It indicates that this metric is a gauge that can be incremented.
   */
  readonly type: "gauge";

  /**
   * A brief description of the gauge's purpose.
   * This can be used to provide additional context about what the gauge represents.
   * For example, "Current memory usage in bytes" or "Number of active users in the system".
   */
  readonly description?: string;

  /**
   * The value of the gauge.
   */
  readonly value: Record<string, number>;

  /**
   * Optional labels for the gauge.
   * Labels are key-value pairs that can be used to add additional context to the gauge.
   * For example, you might use labels to indicate the environment (e.g., "production", "development") or the service (e.g., "user-service", "order-service").
   */
  readonly labels?: TLabel[];

  /**
   * Optional kind for gauge metrics.
   */
  readonly kind?: GaugeKind;

  private _tags?: Record<string, string>;
  private _onChange?: (self: Gauge<TLabel>) => void;
  private _initialValue: number = 0;
  private _lastUpdated: number = Date.now();

  /**
   * Gets the timestamp of when the gauge was last updated.
   * This is a Unix timestamp in milliseconds.
   * @returns The last updated timestamp.
   */
  get lastUpdated(): number {
    return this._lastUpdated;
  }

  /**
   * Gets tags associated with the gauge.
   * Tags are key-value pairs that provide additional context about the gauge.
   * @returns An object containing tags, or undefined if no tags are set.
   */
  get tags(): Record<string, string> | undefined {
    return this._tags;
  }

  /**
   * Sets tags for the gauge.
   * Tags are key-value pairs that provide additional context about the gauge.
   * @param tags An object containing tags to set.
   */
  set tags(tags: Record<string, string> | undefined) {
    if (tags && typeof tags !== "object") {
      throw new Error("Tags must be an object with key-value pairs.");
    }
    this._tags = tags;
  }

  constructor(name: string);
  constructor(
    name: string,
    attributes: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  );
  constructor(
    name: string,
    attributes?: {
      description?: string;
      initialValue?: number;
      labels?: TLabel[];
      kind?: GaugeKind;
    },
  ) {
    this.name = name;
    this.description = attributes?.description;
    this.kind = attributes?.kind;
    this.type = "gauge";

    const initialValue = attributes?.initialValue ?? 0;
    // Every series starts from this, so a non-finite one is replaced rather
    // than poisoning all of them.
    this._initialValue = admitsFinite(name, initialValue, this.nonFinite)
      ? initialValue
      : 0;
    // Optional, like every other read of `attributes`. Without this the
    // single-argument overload the class advertises - `new Gauge("name")` -
    // threw "Cannot read properties of undefined".
    this.labels = attributes?.labels;
    this.value = {
      [DEFAULT_LABEL]: this._initialValue,
    };
  }

  /**
   * Gets the current value of the gauge.
   * If labels are defined, you must specify a label to get the value for that label.
   * If no label is specified, it returns the value for the default label.
   * @returns The current value of the gauge.
   */
  getValue(): number;
  /**
   * Gets the current value of the gauge.
   * If labels are defined, you must specify a label to get the value for that label.
   * If no label is specified, it returns the value for the default label.
   * @param label Optional label to get the value for. If not provided, returns the default value.
   * @returns The current value of the gauge.
   */
  getValue(label: Record<TLabel, string | number>): number;
  getValue(label?: Record<TLabel, string | number>): number {
    if (this.labels && !label) {
      throw new Error(
        "Cannot get value of a gauge with labels without specifying a label. For example, use `gauge.getValue({ route: '/login' })`.",
      );
    } else if (this.labels && label) {
      this.validateLabels(label);

      const stringifiedLabel = stringifyLabel(label);
      // Presence, not truthiness: a gauge legitimately sitting at 0 is the most
      // common reading there is, and `!0` made it indistinguishable from a label
      // that was never recorded.
      if (!(stringifiedLabel in this.value)) {
        throw new Error(
          `Label "${stringifiedLabel}" does not exist in the gauge. Available labels: ${Object.keys(
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
   * Increments the gauge by a specified value.
   * If no value is provided, it defaults to 1.
   */
  increment(): void;
  /**
   * Increments the gauge by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to increment the gauge for.
   */
  increment(label: Record<TLabel, string | number>): void;
  /**
   * Increments the gauge by a specified value.
   * @param value Value to increment the gauge by.
   */
  increment(value: number): void;
  /**
   * Increments the gauge by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to increment the gauge for.
   * @param value Value to increment the gauge by.
   */
  increment(label: Record<TLabel, string | number>, value: number): void;
  increment(
    labelOrValue?: Record<TLabel, string | number> | number,
    value?: number,
  ): void {
    if (this.labels && typeof labelOrValue !== "object") {
      throw new Error(
        "Cannot increment a gauge with labels without specifying a label. For example, use `gauge.increment({ route: '/login' })`.",
      );
    }

    if (typeof labelOrValue === "object") {
      this.validateLabels(labelOrValue);

      const stringifiedLabel = stringifyLabel(labelOrValue);
      const incrementValue = value ?? 1;
      if (
        !admitsFinite(this.name, incrementValue, this.nonFinite) ||
        !admitsSeries(this.name, this.value, stringifiedLabel, this.seriesLimit)
      ) {
        return;
      }
      this.value[stringifiedLabel] =
        (this.value[stringifiedLabel] ?? this._initialValue) + incrementValue;
    } else {
      const incrementValue = labelOrValue ?? 1;
      if (!admitsFinite(this.name, incrementValue, this.nonFinite)) {
        return;
      }
      this.value[DEFAULT_LABEL] =
        (this.value[DEFAULT_LABEL] ?? this._initialValue) + incrementValue;
    }
    this._lastUpdated = Date.now();
    if (this._onChange) {
      this._onChange(this);
    }
  }

  /**
   * Decrements the gauge by a specified value.
   * If no value is provided, it defaults to 1.
   */
  decrement(): void;
  /**
   * Decrements the gauge by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to decrement the gauge for.
   */
  decrement(label: Record<TLabel, string | number>): void;
  /**
   * Decrements the gauge by a specified value.
   * @param value Value to decrement the gauge by.
   */
  decrement(value: number): void;
  /**
   * Decrements the gauge by a specified value for a specific label.
   * If no value is provided, it defaults to 1.
   * @param label The label to decrement the gauge for.
   * @param value Value to decrement the gauge by.
   */
  decrement(label: Record<TLabel, string | number>, value: number): void;
  decrement(
    labelOrValue?: Record<TLabel, string | number> | number,
    value?: number,
  ): void {
    if (this.labels && typeof labelOrValue !== "object") {
      throw new Error(
        "Cannot decrement a gauge with labels without specifying a label. For example, use `gauge.decrement({ route: '/login' })`.",
      );
    } else if (typeof labelOrValue === "object") {
      this.validateLabels(labelOrValue);

      const stringifiedLabel = stringifyLabel(labelOrValue);
      const decrementValue = value ?? 1;
      if (
        !admitsFinite(this.name, decrementValue, this.nonFinite) ||
        !admitsSeries(this.name, this.value, stringifiedLabel, this.seriesLimit)
      ) {
        return;
      }
      this.value[stringifiedLabel] =
        (this.value[stringifiedLabel] ?? this._initialValue) - decrementValue;
    } else {
      const decrementValue = labelOrValue ?? 1;
      if (!admitsFinite(this.name, decrementValue, this.nonFinite)) {
        return;
      }
      this.value[DEFAULT_LABEL] =
        (this.value[DEFAULT_LABEL] ?? this._initialValue) - decrementValue;
    }
    this._lastUpdated = Date.now();

    if (this._onChange) {
      this._onChange(this);
    }
  }

  /**
   * Sets the value of the gauge.
   * If labels are defined, you must specify a label to set the value for that label.
   * If no label is specified, it sets the value for the default label.
   * @param value The value to set for the gauge.
   */
  setValue(value: number): void;
  /**
   * Sets the value of the gauge for a specific label.
   * If labels are defined, you must specify a label to set the value for that label.
   * If no label is specified, it sets the value for the default label.
   * @param label The label to set the value for.
   * @param value The value to set for the gauge.
   */
  setValue(label: Record<TLabel, string | number>, value: number): void;
  setValue(
    labelOrValue?: Record<TLabel, string | number> | number,
    value?: number,
  ): void {
    if (this.labels && typeof labelOrValue !== "object") {
      throw new Error(
        "Cannot set value of a gauge with labels without specifying a label. For example, use `gauge.setValue({ route: '/login' }, 42)`.",
      );
    } else if (typeof labelOrValue === "object") {
      this.validateLabels(labelOrValue);

      const stringifiedLabel = stringifyLabel(labelOrValue);
      const newValue = value ?? this._initialValue;
      if (
        !admitsFinite(this.name, newValue, this.nonFinite) ||
        !admitsSeries(this.name, this.value, stringifiedLabel, this.seriesLimit)
      ) {
        return;
      }
      this.value[stringifiedLabel] = newValue;
    } else {
      // A gauge starts at 0 by default, so the truthiness check here rejected
      // the very first `setValue` on almost every gauge - with a message that
      // named the label it claimed was missing among the available ones.
      if (!(DEFAULT_LABEL in this.value)) {
        throw new Error(
          `Default label "${DEFAULT_LABEL}" does not exist in the gauge. Available labels: ${Object.keys(
            this.value,
          ).join(", ")}.`,
        );
      }
      const newValue = labelOrValue ?? this._initialValue;
      if (!admitsFinite(this.name, newValue, this.nonFinite)) {
        return;
      }
      this.value[DEFAULT_LABEL] = newValue;
    }
    this._lastUpdated = Date.now();

    if (this._onChange) {
      this._onChange(this);
    }
  }

  private validateLabels(labeledValue: Record<TLabel, string | number>): void {
    const keys = Object.keys(labeledValue);
    const declared = this.labels;
    declared?.forEach((label) => {
      if (!keys.includes(label)) {
        throw new Error(
          `Label "${label}" is not defined in the gauge. Available labels: ${declared.join(
            ", ",
          )}.`,
        );
      }
    });
  }
}
