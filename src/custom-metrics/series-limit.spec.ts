import type { MockInstance } from "vitest";
import { Counter, MAX_SERIES_PER_METRIC } from "./counter.js";
import { Gauge } from "./gauge.js";
import { Summary } from "./summary.js";

describe("series cardinality cap", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const fill = (record: (label: Record<string, string>) => void, n: number) => {
    for (let i = 0; i < n; i++) {
      record({ userId: `user-${i}` });
    }
  };

  describe("counter", () => {
    it("keeps recording up to the cap", () => {
      const counter = new Counter<"userId">("logins", "d", ["userId"]);

      fill((label) => counter.increment(label), MAX_SERIES_PER_METRIC);

      expect(Object.keys(counter.value)).toHaveLength(MAX_SERIES_PER_METRIC);
      expect(warn).not.toHaveBeenCalled();
    });

    it("stops creating series past the cap rather than growing forever", () => {
      const counter = new Counter<"userId">("logins", "d", ["userId"]);

      fill((label) => counter.increment(label), MAX_SERIES_PER_METRIC + 500);

      expect(Object.keys(counter.value)).toHaveLength(MAX_SERIES_PER_METRIC);
    });

    it("keeps updating the series it already has", () => {
      const counter = new Counter<"userId">("logins", "d", ["userId"]);
      fill((label) => counter.increment(label), MAX_SERIES_PER_METRIC + 10);

      counter.increment({ userId: "user-0" }, 5);

      // An established series must not be collateral damage of the cap.
      expect(counter.getValue({ userId: "user-0" })).toEqual(6);
    });

    it("does not throw at the cap - the host application must keep running", () => {
      const counter = new Counter<"userId">("logins", "d", ["userId"]);

      expect(() =>
        fill((label) => counter.increment(label), MAX_SERIES_PER_METRIC + 5),
      ).not.toThrow();
    });

    it("reports the cap once, not once per dropped series", () => {
      const counter = new Counter<"userId">("logins", "d", ["userId"]);

      fill((label) => counter.increment(label), MAX_SERIES_PER_METRIC + 100);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("logins");
    });
  });

  describe("gauge", () => {
    it("caps increment", () => {
      const gauge = new Gauge<"userId">("sessions", { labels: ["userId"] });

      fill((label) => gauge.increment(label), MAX_SERIES_PER_METRIC + 50);

      // The default series is seeded in the constructor, so the cap is reached
      // one user earlier than for a counter.
      expect(Object.keys(gauge.value).length).toBeLessThanOrEqual(
        MAX_SERIES_PER_METRIC,
      );
    });

    it("caps decrement too", () => {
      const gauge = new Gauge<"userId">("sessions", { labels: ["userId"] });

      fill((label) => gauge.decrement(label), MAX_SERIES_PER_METRIC + 50);

      expect(Object.keys(gauge.value).length).toBeLessThanOrEqual(
        MAX_SERIES_PER_METRIC,
      );
    });
  });

  /**
   * A summary that declared no labels takes any. Its window is cleared only
   * when a flush is written, which an agent sending nothing - switched off,
   * or without credentials - never does: each new label stayed for the life
   * of the process.
   */
  describe("summary without declared labels", () => {
    const observeEach = (summary: Summary<string>, n: number, from = 0) => {
      for (let i = from; i < from + n; i++) {
        summary.observe(1, `user-${i}`);
      }
    };

    it("stops taking labels at the cap, keeping the ones it has", () => {
      const summary = new Summary<string>("search_ms");

      observeEach(summary, MAX_SERIES_PER_METRIC + 500);
      summary.observe(7, "user-0");

      const observations = summary.observations;
      expect(Object.keys(observations)).toHaveLength(MAX_SERIES_PER_METRIC);
      expect(observations["user-0"]).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('"search_ms"');
    });

    it("takes them again in the next window, without another warning", () => {
      const summary = new Summary<string>("search_ms");
      observeEach(summary, MAX_SERIES_PER_METRIC + 1);

      summary.markFlushed();
      observeEach(summary, MAX_SERIES_PER_METRIC + 1, 5_000);

      expect(Object.keys(summary.observations)).toHaveLength(
        MAX_SERIES_PER_METRIC,
      );
      expect(summary.observations["user-5000"]).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("refuses a label longer than the collector accepts", () => {
      const summary = new Summary<string>("search_ms");

      summary.observe(1, "a".repeat(256));
      summary.observe(1, "b".repeat(90_000));
      summary.observe(1, "c".repeat(255));

      expect(Object.keys(summary.observations)).toEqual(["c".repeat(255)]);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("leaves a summary that declared its labels alone", () => {
      const labels = Array.from(
        { length: MAX_SERIES_PER_METRIC + 1 },
        (_, i) => `l${i}`,
      );
      const summary = new Summary<string>("declared", { labels });

      for (const label of labels) {
        summary.observe(1, label);
      }

      expect(Object.keys(summary.observations)).toHaveLength(labels.length);
    });
  });
});

describe("series key length", () => {
  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  // A series key is the label combination as JSON - `{"url":"..."}`, ten
  // characters around the value - so this builds a key of exactly `length`.
  const url = (length: number) => ({ url: "/".padEnd(length - 10, "a") });

  it("refuses a combination longer than the collector accepts", () => {
    const counter = new Counter<"url">("hits", "d", ["url"]);

    counter.increment(url(256));
    counter.increment(url(300));
    counter.increment({ url: "/short" });

    // One key over 255 characters and the collector refuses the whole batch,
    // logs and spans included - not just this metric.
    expect(Object.keys(counter.value)).toEqual(['{"url":"/short"}']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('"hits"');
  });

  it("admits one of exactly the longest length", () => {
    const counter = new Counter<"url">("hits", "d", ["url"]);

    counter.increment(url(255));

    expect(Object.keys(counter.value)).toEqual([JSON.stringify(url(255))]);
  });

  it("refuses one on a gauge too, in either direction", () => {
    const gauge = new Gauge<"url">("in_flight", { labels: ["url"] });

    gauge.increment(url(256));
    gauge.decrement(url(300));

    expect(Object.keys(gauge.value)).toEqual(["default"]);
  });
});
