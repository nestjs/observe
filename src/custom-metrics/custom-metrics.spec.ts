import type { MockInstance } from "vitest";
import { Counter } from "./counter.js";
import { Gauge } from "./gauge.js";
import { Summary } from "./summary.js";

describe("Counter", () => {
  it("starts at zero and counts up", () => {
    const counter = new Counter("logins");

    expect(counter.getValue()).toBe(0);
    counter.increment();
    counter.increment();
    expect(counter.getValue()).toBe(2);
  });

  it("increments by an explicit amount", () => {
    const counter = new Counter("bytes");

    counter.increment(512);

    expect(counter.getValue()).toBe(512);
  });

  it("honours an initial value", () => {
    const counter = new Counter("resumed", "desc", 100);

    counter.increment();

    expect(counter.getValue()).toBe(101);
  });

  describe("labels", () => {
    it("keeps a separate total per label", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      counter.increment({ route: "/a" });
      counter.increment({ route: "/a" });
      counter.increment({ route: "/b" });

      expect(counter.getValue({ route: "/a" })).toBe(2);
      expect(counter.getValue({ route: "/b" })).toBe(1);
    });

    it("refuses an unlabelled increment on a labelled counter", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      // Silently folding this into a "default" bucket would produce a total that
      // belongs to no route and is double counted against the labelled ones.
      expect(() => counter.increment()).toThrow(/without specifying a label/);
    });

    it("refuses an unlabelled read on a labelled counter", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      expect(() => counter.getValue()).toThrow(/without specifying a label/);
    });

    it("rejects a label object missing a declared key", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      expect(() => counter.increment({ method: "GET" } as never)).toThrow(
        /not defined in the counter/,
      );
    });

    it("reads back a label incremented by zero", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      counter.increment({ route: "/a" }, 0);

      // Presence, not truthiness: a recorded zero is a reading, not a miss.
      expect(counter.getValue({ route: "/a" })).toBe(0);
    });

    it("rejects a label that was never recorded", () => {
      const counter = new Counter<"route">("requests", "desc", ["route"]);

      expect(() => counter.getValue({ route: "/never" })).toThrow(
        /does not exist/,
      );
    });

    it("treats the same label set in any key order as one series", () => {
      const counter = new Counter<"route" | "method">("requests", "desc", [
        "route",
        "method",
      ]);

      counter.increment({ route: "/a", method: "GET" });
      counter.increment({ method: "GET", route: "/a" });

      // Keys are sorted before serialisation; insertion order would otherwise
      // split one series into two and halve every total.
      expect(counter.getValue({ method: "GET", route: "/a" })).toBe(2);
      expect(Object.keys(counter.value)).toHaveLength(1);
    });
  });

  describe("increase", () => {
    it("reports everything counted before the first flush", () => {
      const counter = new Counter("orders");

      counter.increment(5);

      expect(counter.increase).toEqual({ default: 5 });
    });

    it("reports only what accrued since the last flush", () => {
      const counter = new Counter("orders");
      counter.increment(5);

      counter.markFlushed();
      counter.increment(3);

      // The backend sums increases; reporting the cumulative value each time
      // would double count on every flush.
      expect(counter.increase).toEqual({ default: 3 });
    });

    it("reports zero when nothing happened since the flush", () => {
      const counter = new Counter("orders");
      counter.increment(5);
      counter.markFlushed();

      expect(counter.increase).toEqual({ default: 0 });
    });

    it("rolls a missed flush into the next one", () => {
      const counter = new Counter("orders");
      counter.increment(5);
      // No markFlushed: the agent only calls it once a flush has been written,
      // so a failed send must not consume the increase.
      counter.increment(3);

      expect(counter.increase).toEqual({ default: 8 });
    });

    it("tracks increases per label independently", () => {
      const counter = new Counter<"region">("sales", "desc", ["region"]);
      counter.increment({ region: "eu" }, 10);
      counter.increment({ region: "us" }, 20);
      counter.markFlushed();

      counter.increment({ region: "eu" }, 5);

      expect(counter.increase).toEqual({
        '{"region":"eu"}': 5,
        '{"region":"us"}': 0,
      });
    });
  });

  it("records when it was last touched", () => {
    const counter = new Counter("touched");
    const before = counter.lastUpdated;

    counter.increment();

    expect(counter.lastUpdated).toBeGreaterThanOrEqual(before);
  });
});

describe("Gauge", () => {
  it("can be constructed with only a name", () => {
    // The single-argument overload is declared on the class; it used to throw
    // "Cannot read properties of undefined (reading 'labels')".
    const gauge = new Gauge("queue_depth");

    expect(gauge.getValue()).toBe(0);
  });

  it("goes up and down", () => {
    const gauge = new Gauge("in_flight", {});

    gauge.increment();
    gauge.increment(4);
    gauge.decrement(2);

    expect(gauge.getValue()).toBe(3);
  });

  it("can go negative", () => {
    const gauge = new Gauge("balance", {});

    gauge.decrement(5);

    // Unlike a counter, a gauge is a level and may legitimately sit below zero.
    expect(gauge.getValue()).toBe(-5);
  });

  describe("setValue", () => {
    it("sets a value on a freshly created gauge", () => {
      const gauge = new Gauge("temperature", {});

      // A gauge starts at 0, and the guard here tested truthiness - so the very
      // first `setValue` on almost every gauge threw, claiming the default label
      // did not exist while listing it as available.
      gauge.setValue(42);

      expect(gauge.getValue()).toBe(42);
    });

    it("sets a value of zero", () => {
      const gauge = new Gauge("temperature", { initialValue: 10 });

      gauge.setValue(0);

      expect(gauge.getValue()).toBe(0);
    });

    it("replaces rather than accumulates", () => {
      const gauge = new Gauge("temperature", {});

      gauge.setValue(10);
      gauge.setValue(20);

      expect(gauge.getValue()).toBe(20);
    });
  });

  it("honours an initial value", () => {
    const gauge = new Gauge("preset", { initialValue: 7 });

    expect(gauge.getValue()).toBe(7);
  });

  it("carries its aggregation kind", () => {
    // The kind decides how the backend merges readings from several instances.
    expect(new Gauge("g", { kind: "peak" }).kind).toBe("peak");
    expect(new Gauge("g", { kind: "ratio" }).kind).toBe("ratio");
    expect(new Gauge("g", { kind: "additive" }).kind).toBe("additive");
  });

  describe("labels", () => {
    it("sets a value on a label that was never recorded", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });

      gauge.setValue({ pool: "main" }, 5);

      expect(gauge.getValue({ pool: "main" })).toBe(5);
    });

    it("keeps a separate level per label", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });

      gauge.increment({ pool: "read" }, 3);
      gauge.increment({ pool: "write" }, 1);

      expect(gauge.getValue({ pool: "read" })).toBe(3);
      expect(gauge.getValue({ pool: "write" })).toBe(1);
    });

    it("refuses an unlabelled operation on a labelled gauge", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });

      expect(() => gauge.increment()).toThrow(/without specifying a label/);
      expect(() => gauge.decrement()).toThrow(/without specifying a label/);
      expect(() => gauge.setValue(1)).toThrow(/without specifying a label/);
    });

    it("reads back a label sitting at zero", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });

      gauge.increment({ pool: "read" }, 5);
      gauge.decrement({ pool: "read" }, 5);

      expect(gauge.getValue({ pool: "read" })).toBe(0);
    });
  });

  describe("tags", () => {
    it("round-trips tags", () => {
      const gauge = new Gauge("tagged", {});

      gauge.tags = { env: "prod" };

      expect(gauge.tags).toEqual({ env: "prod" });
    });
  });
});

describe("Summary", () => {
  it("computes quantiles over what it observed", () => {
    const summary = new Summary("latency");

    for (let value = 1; value <= 100; value++) {
      summary.observe(value);
    }

    expect(summary.p50.default).toBeGreaterThan(40);
    expect(summary.p50.default).toBeLessThan(60);
    expect(summary.p95.default).toBeGreaterThan(90);
    expect(summary.p99.default).toBeGreaterThanOrEqual(summary.p95.default);
  });

  it("tracks count, total and maximum exactly", () => {
    const summary = new Summary("latency");

    summary.observe(10);
    summary.observe(20);
    summary.observe(30);

    // These merge exactly across instances, where quantiles only estimate - so
    // a mean and a worst case built from them stay truthful.
    expect(summary.observations.default).toBe(3);
    expect(summary.total.default).toBe(60);
    expect(summary.maximum.default).toBe(30);
  });

  it("stays bounded however many observations arrive", () => {
    const summary = new Summary("latency");

    for (let i = 0; i < 20_000; i++) {
      summary.observe(i);
    }

    // A summary must not grow with throughput; the exact aggregates still cover
    // everything that was seen.
    expect(summary.observations.default).toBe(20_000);
    expect(summary.total.default).toBeGreaterThan(0);
  });

  it("keeps an independent distribution per label", () => {
    const summary = new Summary<"route">("latency", { labels: ["route"] });

    summary.observe(10, "route");
    summary.observe(1000, "route");

    expect(summary.observations.route).toBe(2);
    expect(summary.maximum.route).toBe(1000);
  });

  it("refuses an unlabelled observation on a labelled summary", () => {
    const summary = new Summary<"route">("latency", { labels: ["route"] });

    expect(() => summary.observe(10)).toThrow(/without specifying one/);
  });

  it("starts a fresh window after a flush", () => {
    const summary = new Summary("latency");
    summary.observe(10);
    summary.observe(20);

    summary.markFlushed();
    summary.observe(100);

    // Quantiles describe the window since the last flush, so carrying the old
    // observations forward would smear a spike across every window after it.
    expect(summary.observations.default).toBe(1);
    expect(summary.maximum.default).toBe(100);
  });
});

/**
 * A NaN or an Infinity is usually computed from the application's own data, in
 * the middle of its own request handler, so it is ignored rather than thrown -
 * as a series past the cap is: the host application must keep running.
 * Recorded, it would reach the collector as null.
 */
describe("non-finite values", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  describe("counter", () => {
    it("ignores one and keeps counting", () => {
      const counter = new Counter("orders");

      counter.increment(Number.NaN);
      counter.increment(Number.POSITIVE_INFINITY);
      counter.increment(2);

      // Added in, a single NaN left the counter NaN for the life of the process.
      expect(counter.getValue()).toBe(2);
    });

    it("does not open a series for one", () => {
      const counter = new Counter<"route">("hits", "d", ["route"]);

      counter.increment({ route: "/a" }, Number.NaN);

      expect(counter.value).toEqual({});
      counter.increment({ route: "/a" }, 3);
      expect(counter.getValue({ route: "/a" })).toBe(3);
    });

    it("starts from zero rather than a non-finite initial value", () => {
      const counter = new Counter("resumed", "d", Number.NaN);

      counter.increment();

      expect(counter.getValue()).toBe(1);
    });
  });

  describe("gauge", () => {
    it("ignores one in every operation", () => {
      const gauge = new Gauge("cpu");
      gauge.setValue(40);

      gauge.setValue(Number.NaN);
      gauge.increment(Number.POSITIVE_INFINITY);
      gauge.decrement(Number.NEGATIVE_INFINITY);

      expect(gauge.getValue()).toBe(40);
    });

    it("ignores one on a label, without opening a series for it", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });
      gauge.increment({ pool: "main" }, 5);

      gauge.setValue({ pool: "main" }, Number.NaN);
      gauge.increment({ pool: "main" }, Number.NaN);
      gauge.decrement({ pool: "replica" }, Number.NaN);

      expect(gauge.getValue({ pool: "main" })).toBe(5);
      expect(Object.keys(gauge.value)).not.toContain('{"pool":"replica"}');
    });

    it("starts from zero rather than a non-finite initial value", () => {
      const gauge = new Gauge("level", {
        initialValue: Number.POSITIVE_INFINITY,
      });

      expect(gauge.getValue()).toBe(0);
    });
  });

  describe("summary", () => {
    it("ignores one rather than throwing", () => {
      const summary = new Summary("latency");
      summary.observe(10);

      // Thrown, it failed whatever request was being measured.
      expect(() => summary.observe(Number.NaN)).not.toThrow();
      summary.observe(Number.POSITIVE_INFINITY);
      summary.observe(30);

      // Recorded, it would poison every quantile and the total.
      expect(summary.observations.default).toBe(2);
      expect(summary.total.default).toBe(40);
      expect(summary.p99.default).toBe(30);
    });
  });

  it("warns once per metric, naming it", () => {
    const orders = new Counter("orders");
    const latency = new Summary("latency");

    orders.increment(Number.NaN);
    orders.increment(Number.NaN);
    latency.observe(Number.NaN);

    // A silent refusal is indistinguishable from a metric that does not work.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('"orders"');
    expect(warn.mock.calls[1][0]).toContain('"latency"');
  });

  describe("a finite step that would take a reading past the largest number", () => {
    /** Finite on its own; twice it is past the largest double. */
    const HUGE = 1e308;

    it("is ignored by a counter, which keeps its last reading", () => {
      const counter = new Counter("raised");

      // Each is finite and passes any "positive number" check; added in, the
      // counter stayed at Infinity - null on the wire - for good.
      counter.increment(HUGE);
      counter.increment(HUGE);
      counter.increment(HUGE);

      expect(counter.getValue()).toBe(HUGE);
      expect(counter.increase).toEqual({ default: HUGE });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"raised"');
      expect(warn.mock.calls[0][0]).toContain("largest");
    });

    it("is ignored on a label, without opening a series for it", () => {
      const counter = new Counter<"currency">("raised", "d", HUGE, [
        "currency",
      ]);
      counter.increment({ currency: "eur" }, 0);

      counter.increment({ currency: "eur" }, HUGE);
      counter.increment({ currency: "usd" }, HUGE);

      expect(counter.value).toEqual({ '{"currency":"eur"}': HUGE });
    });

    it("keeps a counter's increase since the last flush a number", () => {
      const counter = new Counter<"account">("balance", "d", ["account"]);
      counter.increment({ account: "a" }, -HUGE);
      counter.markFlushed();

      // Both readings are finite, but the rise from -1e308 to 1e308 is not.
      counter.increment({ account: "a" }, HUGE);
      counter.increment({ account: "a" }, HUGE);

      expect(counter.getValue({ account: "a" })).toBe(0);
      expect(counter.increase).toEqual({ '{"account":"a"}': HUGE });
    });

    it("is ignored by a gauge, up or down", () => {
      const gauge = new Gauge("level");

      gauge.increment(HUGE);
      gauge.increment(HUGE);
      expect(gauge.getValue()).toBe(HUGE);

      gauge.setValue(-HUGE);
      gauge.decrement(HUGE);
      expect(gauge.getValue()).toBe(-HUGE);
    });

    it("is ignored on a gauge's label, up or down", () => {
      const gauge = new Gauge<"pool">("connections", { labels: ["pool"] });

      gauge.increment({ pool: "main" }, HUGE);
      gauge.increment({ pool: "main" }, HUGE);
      gauge.decrement({ pool: "replica" }, HUGE);
      gauge.decrement({ pool: "replica" }, HUGE);

      expect(gauge.getValue({ pool: "main" })).toBe(HUGE);
      expect(gauge.getValue({ pool: "replica" })).toBe(-HUGE);
    });

    it("is left out of a summary whole, so its count and total agree", () => {
      const summary = new Summary("amount");

      summary.observe(HUGE);
      summary.observe(HUGE);
      summary.observe(5);

      expect(summary.total.default).toBe(HUGE);
      expect(summary.observations.default).toBe(2);
      expect(summary.maximum.default).toBe(HUGE);
    });
  });

  describe("a value that is not a number at run time", () => {
    // What a field of a request body can hold: JSON parses `{"toString": 1}`
    // into an object no string conversion survives, and a deeply nested array
    // overflows the stack of one.
    const deeplyNested = () => {
      let nested: unknown = [];
      for (let i = 0; i < 20_000; i++) {
        nested = [nested];
      }
      return nested;
    };
    const unprintable = (): unknown[] => [
      { toString: 1 },
      deeplyNested(),
      Symbol("amount"),
    ];

    it("ignores it rather than throwing from the warning", () => {
      for (const value of unprintable()) {
        const summary = new Summary("amount");
        const counter = new Counter<"route">("hits", "d", ["route"]);
        const gauge = new Gauge<"pool">("level", { labels: ["pool"] });

        // Thrown from the warning, it failed the request being measured.
        expect(() => summary.observe(value as number)).not.toThrow();
        expect(() =>
          counter.increment({ route: "/a" }, value as number),
        ).not.toThrow();
        expect(() =>
          gauge.setValue({ pool: "main" }, value as number),
        ).not.toThrow();

        expect(summary.observations).toEqual({});
        expect(counter.value).toEqual({});
        expect(gauge.value).toEqual({ default: 0 });
      }
      expect(warn).toHaveBeenCalledTimes(9);
      expect(warn.mock.calls[0][0]).toContain("a value of type object");
      expect(warn.mock.calls[6][0]).toContain("a value of type symbol");
    });

    it("names a string by its type rather than echoing it", () => {
      const summary = new Summary("amount");

      summary.observe("12\u001b[2J" as unknown as number);

      // Written to stderr as given, line breaks and escapes included.
      expect(warn.mock.calls[0][0]).toContain("a value of type string");
      expect(warn.mock.calls[0][0]).not.toContain("\u001b");
    });

    it("still prints the numbers the warning is about", () => {
      new Summary("a").observe(Number.NaN);
      new Summary("b").observe(Number.NEGATIVE_INFINITY);
      new Summary("c").observe(undefined as unknown as number);

      expect(warn.mock.calls[0][0]).toContain("ignored NaN");
      expect(warn.mock.calls[1][0]).toContain("ignored -Infinity");
      expect(warn.mock.calls[2][0]).toContain("ignored undefined");
    });
  });

  it("still throws for a mistake in the call, whatever the value", () => {
    // A missing label fails on every run rather than on unlucky data, so
    // refusing it quietly would only hide the bug.
    const counter = new Counter<"route">("hits", "d", ["route"]);
    const summary = new Summary<"route">("latency", { labels: ["route"] });

    expect(() => counter.increment(Number.NaN)).toThrow(
      /without specifying a label/,
    );
    expect(() => summary.observe(Number.NaN)).toThrow(/without specifying one/);
  });
});
