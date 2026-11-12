import {
  createTelemetrySanitizer,
  sanitizeTelemetryBatch,
  sanitizeTelemetryEntry,
  SECTION_SHAPES,
  validateTelemetryPayload,
} from "./telemetry-wire-contract.js";

/**
 * The sanitizer is the runtime half of the wire contract: the collector
 * validates with `forbidNonWhitelisted` and answers a 400 for the whole batch
 * over one bad entry, so whatever it would refuse has to be repaired or
 * dropped - entry by entry - before the batch leaves the process.
 */
describe("sanitizeTelemetryEntry", () => {
  describe("request snapshots", () => {
    const snapshot = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      ti: "trace-1",
      op: "/users/:id",
      d: 12.5,
      t: [],
      ...overrides,
    });
    // `o`, `c` and `m` are required of every span by the API.
    const span = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      o: "auto",
      c: "UsersService",
      m: "findOne",
      ...overrides,
    });

    it("accepts a well-formed snapshot untouched", () => {
      const entry = snapshot();

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result).toEqual({ ok: true, problems: [] });
      expect(entry).toEqual(snapshot());
    });

    it("strips a leaked start timestamp instead of losing the snapshot", () => {
      // `st` is kept off the wire by `endTrace` deleting `startTimestamp`, but
      // any path that skips `endTrace` leaks it - and the API forbids
      // undeclared keys, batch-wide.
      const entry = snapshot({ st: 123.45 });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(result.problems).toEqual([
        "snapshots.st: not declared by the contract, removed",
      ]);
      expect(entry).not.toHaveProperty("st");
    });

    it("reports a snapshot without a trace id as unsalvageable", () => {
      const result = sanitizeTelemetryEntry(
        "snapshots",
        snapshot({ ti: undefined }),
      );

      expect(result.ok).toBe(false);
      expect(result.problems).toEqual(["snapshots.ti: required"]);
    });

    it("sends a missing trace array empty rather than losing the snapshot", () => {
      // What agents 0.2.1 to 0.3.9 sent for every request whose spans they
      // withheld from a degraded account. The API refuses an operation without
      // the array, and its batch with it - and with nothing to strip, the
      // batch used to be dropped unrepaired.
      const entry = snapshot({ t: undefined });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result).toEqual({
        ok: true,
        problems: ["snapshots.t: required, sent as []"],
      });
      expect(entry.t).toEqual([]);
    });

    it("removes a mistyped optional field rather than the entry", () => {
      const entry = snapshot({ d: "12ms" });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry).not.toHaveProperty("d");
    });

    it("removes an explicit null rather than sending it", () => {
      // Optional means absent is fine; a present null still fails the API's
      // type check.
      const entry = snapshot({ u: null });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry).not.toHaveProperty("u");
    });

    it("removes a non-finite duration, which would arrive as null", () => {
      const entry = snapshot({ d: NaN });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry).not.toHaveProperty("d");
    });

    it("sanitizes trace nodes recursively", () => {
      const entry = snapshot({
        t: [
          span({
            n: "span",
            d: 1,
            leaked: true,
            ch: [span({ n: "child", startTimestamp: 99 })],
          }),
        ],
      });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry.t).toEqual([
        span({ n: "span", d: 1, ch: [span({ n: "child" })] }),
      ]);
    });

    it("keeps a boolean error flag on a trace node", () => {
      // `e: true` is the "failed, but handled - details not captured" form the
      // registry emits for every failed non-root span; stripping it would
      // erase real error signals.
      const entry = snapshot({
        e: { message: "root failed" },
        t: [span({ n: "child", e: true })],
      });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result).toEqual({ ok: true, problems: [] });
      expect(entry.t).toEqual([span({ n: "child", e: true })]);
      expect(entry.e).toEqual({ message: "root failed" });
    });

    it("removes an unusable array element, keeping its siblings", () => {
      const entry = snapshot({
        t: [span({ n: "good" }), "not a span", span({ n: "also good" })],
      });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry.t).toEqual([span({ n: "good" }), span({ n: "also good" })]);
    });

    it("strips undeclared attribute keys", () => {
      // `a` is a modelled shape, not a pass-through: only m/sc/ou are declared.
      const entry = snapshot({ a: { m: "GET", sc: 200, userAgent: "curl" } });

      const result = sanitizeTelemetryEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry.a).toEqual({ m: "GET", sc: 200 });
    });
  });

  describe("other sections", () => {
    it("requires a job id", () => {
      expect(
        sanitizeTelemetryEntry("jobs", { n: "send-mail", ti: "t-1" }).ok,
      ).toBe(false);
      expect(sanitizeTelemetryEntry("jobs", { i: "job-1", ti: "t-1" }).ok).toBe(
        true,
      );
    });

    it("requires a custom metric name", () => {
      const result = sanitizeTelemetryEntry("custom", {
        t: "counter",
        v: { default: 1 },
      });

      expect(result.ok).toBe(false);
    });

    it.each([
      [
        "a labelled counter",
        () => ({
          n: "orders",
          t: "counter",
          v: { '{"region":"eu"}': 5 },
          l: ["region"],
          iv: { '{"region":"eu"}': 2 },
        }),
      ],
      [
        "a summary",
        () => ({
          n: "latency",
          t: "summary",
          q50: { default: 20 },
          q95: { default: 30 },
          q99: { default: 30 },
          ct: { default: 3 },
          sm: { default: 60 },
          mx: { default: 30 },
        }),
      ],
    ])("keeps every per-label reading of %s", (_label, sample) => {
      // Readings are maps from label to number, and `l` the label names.
      // Declared as numbers and an object, a repaired batch sent each metric
      // with nothing but its name.
      const entry = sample();

      const result = sanitizeTelemetryEntry("custom", entry);

      expect(result).toEqual({ ok: true, problems: [] });
      expect(entry).toEqual(sample());
    });

    it("drops a log entry with a non-finite timestamp", () => {
      // NaN survives `typeof` but serializes to null, and `timestamp` is
      // required - nothing to strip, so the entry goes.
      const result = sanitizeTelemetryEntry("logs", {
        timestamp: NaN,
        text: "boom",
      });

      expect(result.ok).toBe(false);
    });

    it("keeps a log entry whose attributes are not an object by stripping them", () => {
      const entry = {
        timestamp: 1,
        text: "hello",
        attributes: ["not", "an", "object"],
      };

      const result = sanitizeTelemetryEntry("logs", entry);

      expect(result.ok).toBe(true);
      expect(entry).not.toHaveProperty("attributes");
    });

    it("repairs runtime metrics by removing what does not conform", () => {
      const entry = {
        c: { u: 0.5, s: 0.1, p: 0.2 },
        m: "oops",
      };

      const result = sanitizeTelemetryEntry("runtime", entry);

      expect(result.ok).toBe(true);
      expect(entry).toEqual({ c: { u: 0.5, s: 0.1, p: 0.2 } });
    });

    it("removes a log line's metadata the API refuses, keeping the line", () => {
      // Each of these alone got the whole batch refused - traces and metrics
      // included - and the repair, knowing only types, found nothing to fix.
      const entry = {
        timestamp: 1,
        text: "hello",
        traceId: "t".repeat(256),
        spanId: "s".repeat(256),
        level: "info",
        context: "c".repeat(256),
      };

      const result = sanitizeTelemetryEntry("logs", entry);

      expect(result).toEqual({
        ok: true,
        problems: [
          "logs.traceId: longer than 255 characters",
          "logs.spanId: longer than 255 characters",
          "logs.level: not one of fatal, error, warn, log, debug, verbose",
          "logs.context: longer than 255 characters",
        ],
      });
      expect(entry).toEqual({ timestamp: 1, text: "hello" });
    });

    it.each([
      ["a character outside the BMP", "😀"],
      ["a variation selector", "\u2764\uFE0F"],
    ])("counts the length of %s the way the API does", (_label, unit) => {
      // Two UTF-16 units each, one character to the API's `@MaxLength`.
      const fits = { timestamp: 1, text: "x", context: unit.repeat(255) };
      const over = { timestamp: 1, text: "x", context: unit.repeat(256) };

      sanitizeTelemetryEntry("logs", fits);
      sanitizeTelemetryEntry("logs", over);

      expect(fits.context).toBe(unit.repeat(255));
      expect(over).not.toHaveProperty("context");
    });

    it("drops an entry whose required field is over its limit", () => {
      const result = sanitizeTelemetryEntry("snapshots", {
        ti: "t".repeat(256),
        op: "/users",
        t: [],
      });

      // A cut trace id would name another trace; there is no fixing it.
      expect(result).toEqual({
        ok: false,
        problems: ["snapshots.ti: longer than 255 characters"],
      });
    });

    it("drops a span the API would refuse, keeping its siblings", () => {
      const span = (overrides: Record<string, unknown>) => ({
        o: "auto",
        c: "UsersService",
        m: "findOne",
        ...overrides,
      });
      const entry: Record<string, unknown> = {
        ti: "t-1",
        op: "/users",
        t: [span({ c: "C".repeat(256) }), span({ o: "other" }), span({})],
      };

      const result = sanitizeTelemetryEntry("snapshots", entry);

      // The API requires both of every span, so the span goes rather than the
      // field - stripping it alone would be refused again.
      expect(result).toEqual({
        ok: true,
        problems: [
          "snapshots.t[1].o: not one of manual, auto",
          "snapshots.t[0].c: longer than 255 characters",
        ],
      });
      expect(entry.t).toEqual([span({})]);
    });

    it("repairs a custom metric's kind and labels", () => {
      const labels = Array.from({ length: 1_002 }, (_, i) => `label-${i}`);
      labels[3] = "l".repeat(256);
      const entry: Record<string, unknown> = {
        n: "orders",
        t: "counter",
        k: "sum",
        l: labels,
      };

      const result = sanitizeTelemetryEntry("custom", entry);

      expect(result).toEqual({
        ok: true,
        problems: [
          "custom.l[3]: longer than 255 characters",
          "custom.l: more than 1000 items, 1 removed",
          "custom.k: not one of additive, ratio, peak",
        ],
      });
      // The head is kept: an over-long label goes alone, then the tail.
      expect(entry.l).toEqual([
        "label-0",
        "label-1",
        "label-2",
        ...Array.from({ length: 997 }, (_, i) => `label-${i + 4}`),
      ]);
      expect(entry).not.toHaveProperty("k");
    });

    it("drops a custom metric of a type the API does not take", () => {
      const result = sanitizeTelemetryEntry("custom", {
        n: "latency",
        t: "histogram",
      });

      expect(result.ok).toBe(false);
    });

    it("keeps a runtime sample's GC breakdown", () => {
      // Each kind is a count and a duration, not a number. Declared as one,
      // every repaired batch lost its whole breakdown and blamed the kinds.
      const sample = () => ({
        g: {
          c: 4,
          td: 20,
          b: {
            m: { count: 3, duration: 12 },
            j: { count: 1, duration: 8 },
            i: { count: 0, duration: 0 },
          },
        },
      });
      const entry = sample();

      const result = sanitizeTelemetryEntry("runtime", entry);

      expect(result).toEqual({ ok: true, problems: [] });
      expect(entry).toEqual(sample());
    });
  });

  describe("whole batches", () => {
    it("drops only the unsalvageable entry, keeping the batch", () => {
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [],
        logs: [
          { timestamp: 1, text: "kept" },
          // No text at all - required, nothing to strip, entry goes alone.
          { timestamp: 2 },
        ],
      };

      const result = sanitizeTelemetryBatch(payload);

      expect(result.changed).toBe(true);
      expect(result.dropped).toBe(1);
      expect(payload.logs).toEqual([{ timestamp: 1, text: "kept" }]);
    });

    it("drops a snapshot with an unusable operation id rather than re-send it without one", () => {
      // The API requires `op`: stripped and re-sent, the entry would be
      // refused again, and the whole batch with it.
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [
          { ti: "t-1", op: 42, t: [] },
          { ti: "t-2", op: "/users", t: [] },
        ],
      };

      const result = sanitizeTelemetryBatch(payload);

      expect(result).toMatchObject({ changed: true, dropped: 1 });
      expect(payload.snapshots).toEqual([{ ti: "t-2", op: "/users", t: [] }]);
      expect(
        validateTelemetryPayload(payload, { forbidUnknown: true }),
      ).toEqual([]);
    });

    // What the worker parses back from a refused batch: `JSON.stringify` has
    // already made a non-finite number `null` - a Bull job's
    // `attempts: Infinity` arrives as `"ma": null`. Removing it is a repair,
    // and a repair not reported is a batch dropped instead of re-sent.
    it("reports the removal of a null, so the repaired batch is sent again", () => {
      const payload = JSON.parse(
        JSON.stringify({
          serviceId: "svc",
          snapshots: [{ ti: "t-1", op: "/users", t: [], u: null }],
        }),
      ) as Record<string, unknown>;

      const result = sanitizeTelemetryBatch(payload);

      expect(result.changed).toBe(true);
      expect(result.problems).toEqual(["snapshots.u: null, removed"]);
      expect(payload.snapshots).toEqual([{ ti: "t-1", op: "/users", t: [] }]);
    });

    it("reports nothing for a field that holds undefined, which never reaches the wire", () => {
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [{ ti: "t-1", op: "/users", t: [], u: undefined }],
      };

      expect(sanitizeTelemetryBatch(payload).changed).toBe(false);
    });

    it("takes the operation id a renamed request replaced", () => {
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [
          {
            ti: "t-1",
            op: "/rpc/orders.list",
            a: { m: "POST", sc: 201, ou: "/rpc", dop: "/rpc" },
            t: [],
          },
        ],
      };

      expect(
        validateTelemetryPayload(payload, { forbidUnknown: true }),
      ).toEqual([]);
      expect(sanitizeTelemetryBatch(payload).changed).toBe(false);
    });

    it("removes unusable runtime metrics without touching the rest", () => {
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [{ ti: "t-1", op: "/users", t: [] }],
        runtime: "corrupt",
      };

      const result = sanitizeTelemetryBatch(payload);

      expect(result.dropped).toBe(1);
      expect(payload).not.toHaveProperty("runtime");
      expect(payload.snapshots).toHaveLength(1);
    });

    it("reports a batch already in contract as unchanged", () => {
      // `changed: false` is what tells the worker a 400 was not the payload's
      // fault - nothing to repair, so nothing to re-send.
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [{ ti: "t-1", op: "/users", d: 3, t: [] }],
        logs: [{ timestamp: 1, text: "hello" }],
      };

      const result = sanitizeTelemetryBatch(payload);

      expect(result).toEqual({ changed: false, dropped: 0, problems: [] });
    });

    it("repairs a batch the API refused over one log line's metadata", () => {
      // What one injected log line used to cost: every snapshot and log in
      // the batch, since the repair found nothing it knew how to fix.
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        snapshots: [{ ti: "t-1", op: "/users", d: 3, t: [] }],
        logs: [
          { timestamp: 1, text: "kept" },
          {
            timestamp: 2,
            text: "forged",
            level: "info",
            context: "C".repeat(300),
            traceId: "T".repeat(300),
          },
        ],
      };
      expect(validateTelemetryPayload(payload)).toEqual([
        "logs[1].traceId: longer than 255 characters",
        "logs[1].level: not one of fatal, error, warn, log, debug, verbose",
        "logs[1].context: longer than 255 characters",
      ]);

      const result = sanitizeTelemetryBatch(payload);

      expect(result).toMatchObject({ changed: true, dropped: 0 });
      expect(payload.logs).toEqual([
        { timestamp: 1, text: "kept" },
        { timestamp: 2, text: "forged" },
      ]);
      expect(
        validateTelemetryPayload(payload, { forbidUnknown: true }),
      ).toEqual([]);
    });

    it("repairs a degraded batch whose operations lost their trace arrays", () => {
      // The batch nestjs/observe#14 was reported over, refused with
      // `jobs.0.t must be an array`: every operation is kept, and it then
      // passes the contract `truncatedSpans` and all.
      const payload: Record<string, unknown> = {
        serviceId: "svc",
        truncatedSpans: 4,
        snapshots: [{ ti: "t-1", op: "/users", d: 3 }],
        jobs: [{ i: "job-1", ti: "t-2", d: 10 }],
      };

      const result = sanitizeTelemetryBatch(payload);

      expect(result).toEqual({
        changed: true,
        dropped: 0,
        problems: [
          "snapshots.t: required, sent as []",
          "jobs.t: required, sent as []",
        ],
      });
      expect(
        validateTelemetryPayload(payload, { forbidUnknown: true }),
      ).toEqual([]);
    });
  });

  describe("self-containment", () => {
    it("survives stringify-and-eval, which is how the worker receives it", () => {
      // The detached worker gets the factory as source
      // (`createTelemetrySanitizer.toString()`) and the shapes through
      // `workerData`. A reference to anything in the contract module's scope
      // would pass every direct-call test and then throw inside the worker -
      // this test runs the factory the way the worker does.
      const rebuilt = new Function(
        `return (${createTelemetrySanitizer.toString()})`,
      )()(JSON.parse(JSON.stringify(SECTION_SHAPES)));

      const entry: Record<string, unknown> = {
        ti: "t-1",
        op: "/users",
        st: 123,
      };
      const result = rebuilt.sanitizeEntry("snapshots", entry);

      expect(result.ok).toBe(true);
      expect(entry).not.toHaveProperty("st");
      // The fallback travels with the shapes, so it has to survive that trip.
      expect(entry.t).toEqual([]);

      // So do the limits, and the length the worker counts them by.
      const log: Record<string, unknown> = {
        timestamp: 1,
        text: "x",
        level: "info",
        context: "😀".repeat(256),
      };
      expect(rebuilt.sanitizeEntry("logs", log).ok).toBe(true);
      expect(log).toEqual({ timestamp: 1, text: "x" });
    });
  });
});
