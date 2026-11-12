import { CustomMetric } from "../interfaces/custom-metric.interface.js";
import { MAX_SERIES_PER_METRIC } from "./counter.js";
import { admitsFinite, admitsReading } from "./finite-value.util.js";
import { MAX_SERIES_KEY_LENGTH } from "./label-values.util.js";

const DEFAULT_LABEL = "default" as const;

/**
 * How many observations per label are kept to compute quantiles from.
 *
 * A summary must not grow with throughput, so observations past this are
 * reservoir-sampled rather than appended. The count, sum and maximum are tracked
 * separately and stay exact however many observations arrive.
 */
const DEFAULT_SAMPLE_SIZE = 2048;

/**
 * A distribution of observations - request latency being the usual case.
 *
 * Quantiles are computed here, in-process, over the observations seen since the
 * last flush; the backend only ever receives finished numbers. That keeps the
 * payload flat and small, at the cost of quantiles that cannot be merged exactly
 * across instances - the backend averages them, which estimates rather than
 * derives the true percentile. `observations`, `total` and `maximum` carry no
 * such caveat: they merge exactly, so a mean and a worst case built from them
 * stay truthful across any number of reporters.
 */
export class Summary<TLabel extends string = typeof DEFAULT_LABEL>
  implements CustomMetric<TLabel>
{
  /**
   * Whether a non-finite observation has already been reported. An object so
   * `admitsFinite` can set it, as with the counter's and gauge's latches.
   */
  private readonly nonFinite = { warned: false };

  /**
   * Whether a label past the cap, or one too long, has been reported: once
   * per metric, though the cap is reached again in every window it fills.
   */
  private readonly labelLimit = { capWarned: false, longWarned: false };

  /** How many labels the current window holds. */
  private _windowLabels = 0;

  /**
   * The name of the summary.
   * This should be a descriptive name that identifies the distribution.
   * For example, "http_request_duration_ms" or "db_query_duration_ms".
   */
  readonly name: string;

  /**
   * The type of the custom metric.
   * This is always 'summary' for this class.
   */
  readonly type: "summary";

  /**
   * A brief description of the summary's purpose.
   * For example, "Request latency in milliseconds".
   */
  readonly description?: string;

  /**
   * Optional labels for the summary.
   * Each label accumulates its own independent distribution.
   */
  readonly labels?: TLabel[];

  private _tags?: Record<string, string>;
  private _onChange?: (self: Summary<TLabel>) => void;
  private _lastUpdated: number = Date.now();
  private readonly _sampleSize: number;

  /**
   * Exact per-label aggregates for the current window. Tracked apart from the
   * sample below so they describe every observation, not just the retained ones.
   */
  private _count: Record<string, number> = {};
  private _sum: Record<string, number> = {};
  private _max: Record<string, number> = {};

  /**
   * Bounded per-label sample the quantiles are read off.
   */
  private _samples: Record<string, number[]> = {};

  /**
   * The medians, doubling as the metric's headline reading.
   *
   * A distribution has no single value, so this is what stands in wherever one
   * number is needed. It is a getter, which means `for...in` cannot see it and
   * the encoder leaves it off the wire - the backend derives the same figure
   * from the reported median instead of carrying it twice.
   */
  get value(): Record<string, number> {
    return this.quantile(0.5);
  }

  /**
   * Median per label over the observations since the last flush.
   */
  get p50(): Record<string, number> {
    return this.quantile(0.5);
  }

  /**
   * 95th percentile per label over the observations since the last flush.
   */
  get p95(): Record<string, number> {
    return this.quantile(0.95);
  }

  /**
   * 99th percentile per label over the observations since the last flush.
   */
  get p99(): Record<string, number> {
    return this.quantile(0.99);
  }

  /**
   * How many observations each label saw since the last flush. Exact - this
   * counts every observation, including those the sample dropped.
   */
  get observations(): Record<string, number> {
    return { ...this._count };
  }

  /**
   * Sum of every observation per label since the last flush. Exact. Paired with
   * `observations` it gives the backend a true mean across all reporters, which
   * the quantiles cannot provide.
   */
  get total(): Record<string, number> {
    return { ...this._sum };
  }

  /**
   * Largest single observation per label since the last flush. Exact, and it
   * merges exactly, so the worst case survives being combined across instances.
   */
  get maximum(): Record<string, number> {
    return { ...this._max };
  }

  /**
   * Gets the timestamp of when the summary was last updated.
   * This is a Unix timestamp in milliseconds.
   */
  get lastUpdated(): number {
    return this._lastUpdated;
  }

  /**
   * Gets tags associated with the summary.
   */
  get tags(): Record<string, string> | undefined {
    return this._tags;
  }

  /**
   * Sets tags for the summary.
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
      labels?: TLabel[];
      sampleSize?: number;
    },
  );
  constructor(
    name: string,
    attributes?: {
      description?: string;
      labels?: TLabel[];
      sampleSize?: number;
    },
  ) {
    this.name = name;
    this.description = attributes?.description;
    this.labels = attributes?.labels;
    this.type = "summary";
    this._sampleSize = attributes?.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  }

  /**
   * Records an observation against the default label.
   * @param value The observed value, for example a duration in milliseconds.
   */
  observe(value: number): void;
  /**
   * Records an observation against a specific label.
   * @param value The observed value, for example a duration in milliseconds.
   * @param label One of the labels the summary was declared with.
   */
  observe(value: number, label: TLabel): void;
  observe(value: number, label?: TLabel): void {
    if (this.labels && !label) {
      throw new Error(
        `Cannot observe on a summary with labels without specifying one. For example, use \`summary.observe(12, "${this.labels[0]}")\`.`,
      );
    }
    if (label && this.labels && !this.labels.includes(label)) {
      throw new Error(
        `Label "${label}" is not defined in the summary. Available labels: ${this.labels.join(
          ", ",
        )}.`,
      );
    }
    // A NaN would poison every quantile read off the sample, and the total.
    if (!admitsFinite(this.name, value, this.nonFinite)) {
      return;
    }

    const key = label ?? DEFAULT_LABEL;
    if (!this.labels && !(key in this._count) && !this.admitsLabel(key)) {
      return;
    }
    // Before anything is updated, so the count, maximum and sample keep
    // describing the observations the total does.
    const sum = (this._sum[key] ?? 0) + value;
    if (!admitsReading(this.name, sum, this.nonFinite)) {
      return;
    }
    const count = (this._count[key] ?? 0) + 1;
    if (count === 1) {
      this._windowLabels += 1;
    }
    this._count[key] = count;
    this._sum[key] = sum;
    this._max[key] = Math.max(this._max[key] ?? value, value);
    this.sample(key, value, count);
    this._lastUpdated = Date.now();

    if (this._onChange) {
      this._onChange(this);
    }
  }

  /**
   * Starts a fresh window.
   *
   * Called by the agent only once a flush has actually been written, so a failed
   * flush leaves the window intact and its observations roll into the next one
   * rather than being thrown away.
   */
  markFlushed(): void {
    this._windowLabels = 0;
    this._count = {};
    this._sum = {};
    this._max = {};
    this._samples = {};
  }

  /**
   * Whether a summary that declared no labels may open `label` in this
   * window: one within the cap and short enough for the collector, as a
   * counter's series is.
   *
   * Without it the labels were bounded by nothing but the next flush written,
   * which an agent that sends nothing - switched off, or without credentials -
   * never does: a label taken from a request, a search term say, stayed for
   * the life of the process, at whatever length the request allowed. Refuses
   * rather than throws, for the reason `admitsSeries` gives.
   */
  private admitsLabel(label: string): boolean {
    if (label.length > MAX_SERIES_KEY_LENGTH) {
      if (!this.labelLimit.longWarned) {
        this.labelLimit.longWarned = true;
        console.warn(
          `[observe] Metric "${this.name}" ignored a label of ${label.length} characters; ` +
            `the collector accepts at most ${MAX_SERIES_KEY_LENGTH}. Shorter labels keep recording.`,
        );
      }
      return false;
    }
    if (this._windowLabels < MAX_SERIES_PER_METRIC) {
      return true;
    }
    if (!this.labelLimit.capWarned) {
      this.labelLimit.capWarned = true;
      console.warn(
        `[observe] Metric "${this.name}" reached ${MAX_SERIES_PER_METRIC} distinct labels in one window; ` +
          `further labels are ignored until the next flush. This usually means a label carries something ` +
          `unbounded (a user id, a search term, a URL). Existing labels keep recording.`,
      );
    }
    return false;
  }

  /**
   * Keeps the retained sample uniform over the whole window (Algorithm R).
   *
   * Once the reservoir is full each further observation replaces a random slot
   * with probability sampleSize/count, which leaves every observation equally
   * likely to be present - so quantiles read off the sample stay representative
   * however far throughput outruns the reservoir.
   */
  private sample(key: string, value: number, count: number): void {
    const samples = (this._samples[key] ??= []);
    if (samples.length < this._sampleSize) {
      samples.push(value);
      return;
    }
    const slot = Math.floor(Math.random() * count);
    if (slot < this._sampleSize) {
      samples[slot] = value;
    }
  }

  /**
   * Nearest-rank quantile per label, read off a sorted copy of the sample.
   */
  private quantile(percentile: number): Record<string, number> {
    const quantiles: Record<string, number> = {};
    for (const [key, samples] of Object.entries(this._samples)) {
      if (!samples.length) {
        continue;
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const rank = Math.ceil(percentile * sorted.length) - 1;
      quantiles[key] = sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
    }
    return quantiles;
  }
}
