import { describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import {
  countTraceNodes,
  DEGRADED_MESSAGE_PREFIX,
  DEGRADED_TTL_MS,
  isNotableSnapshot,
  isServerErrorSnapshot,
  NOTABLE_DURATION_MS,
  parseDegradedMessage,
  parseOveragePauseReason,
} from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";

describe("the degraded-ingest protocol", () => {
  it("reads the worker's verdict for a batch", () => {
    // The two values the line carried before trimming existed, meaning what
    // they always meant: `true` is an account out of its allowance.
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}true`)).toBe(
      "reduced",
    );
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}false`)).toBe(
      "full",
    );
  });

  it("tells a paying account's trimmed traces apart from a spent allowance", () => {
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}trimmed`)).toBe(
      "trimmed",
    );
  });

  it("tells a Free account's paced day apart from a spent allowance", () => {
    // Inside its allowance, held back only until 00:00 UTC: read as
    // `reduced`, the operator is told the month is gone when it is not.
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}paced`)).toBe(
      "paced",
    );
  });

  it.each(["errors-only", "errors-only:spike", "errors-only:budget"])(
    "reads `%s` as a paused account's errors-only ingest",
    (value) => {
      expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}${value}`)).toBe(
        "errors-only",
      );
    },
  );

  it("reads an errors-only line as one whatever reason it gives", () => {
    // The reason only words the notice. Read as `full`, a reason this agent
    // has no words for would send a paused account's every request.
    expect(
      parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}errors-only:dunning`),
    ).toBe("errors-only");
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}errors-only:`)).toBe(
      "errors-only",
    );
  });

  it("reads any other value as full ingest, as it always has", () => {
    // Withholding spans on a value nobody defined would lose waterfalls the
    // collector was still keeping, silently.
    expect(parseDegradedMessage(DEGRADED_MESSAGE_PREFIX)).toBe("full");
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}TRUE`)).toBe("full");
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}trim`)).toBe("full");
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}PACED`)).toBe(
      "full",
    );
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}pace`)).toBe("full");
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}ERRORS-ONLY`)).toBe(
      "full",
    );
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}errors-onlyx`)).toBe(
      "full",
    );
    expect(parseDegradedMessage(`${DEGRADED_MESSAGE_PREFIX}errors_only`)).toBe(
      "full",
    );
  });

  it("ignores every other line the worker posts", () => {
    // The channel carries prose the parent logs; only this one line is a
    // protocol, and mistaking a log for one would silently stop spans.
    expect(
      parseDegradedMessage(
        "Tracing and instrumentation data sent successfully",
      ),
    ).toBeNull();
    expect(parseDegradedMessage("Error: Failed to send data.")).toBeNull();
  });
});

describe("why a paused account's line says errors-only", () => {
  it("reads the reasons the notice has words for", () => {
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}errors-only:spike`),
    ).toBe("spike");
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}errors-only:budget`),
    ).toBe("budget");
  });

  it("has none for a line without one, or with one it cannot word", () => {
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}errors-only`),
    ).toBeNull();
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}errors-only:dunning`),
    ).toBeNull();
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}errors-only:SPIKE`),
    ).toBeNull();
  });

  it("has none for any other line", () => {
    // `spike` after another mode is not a pause, and prose is not a line.
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}trimmed:spike`),
    ).toBeNull();
    expect(
      parseOveragePauseReason(`${DEGRADED_MESSAGE_PREFIX}true`),
    ).toBeNull();
    expect(parseOveragePauseReason("errors-only:spike")).toBeNull();
    expect(
      parseOveragePauseReason(
        "Tracing and instrumentation data sent successfully",
      ),
    ).toBeNull();
  });
});

describe("what survives truncation", () => {
  it("keeps a server error's waterfall", () => {
    // Withholding one the collector would have stored loses the customer the
    // waterfall they came for, silently.
    expect(isNotableSnapshot({ a: { sc: 503 } })).toBe(true);
  });

  it("keeps a slow execution, which is the whole reason to open a trace", () => {
    expect(
      isNotableSnapshot({ a: { sc: 200 }, d: NOTABLE_DURATION_MS + 1 }),
    ).toBe(true);
    expect(isNotableSnapshot({ d: NOTABLE_DURATION_MS + 1 })).toBe(true);
  });

  it("keeps an errored execution that carries no status code", () => {
    // A job, or a non-HTTP entry point: nothing grades these but the error.
    expect(isNotableSnapshot({ e: { message: "boom" } })).toBe(true);
  });

  it("lets a status code decide alone where there is one", () => {
    /*
     * The part of the collector's rule that looks wrong and is not: an
     * expected 401 carries an error object exactly like a 500 does, and those
     * plus 429s are most of the daily error count. Consulting the error first
     * would ship a tree for every unauthenticated probe - the traffic this
     * exists to stop shipping.
     */
    expect(isNotableSnapshot({ a: { sc: 401 }, e: { message: "no" } })).toBe(
      false,
    );
    expect(isNotableSnapshot({ a: { sc: 404 }, e: { message: "no" } })).toBe(
      false,
    );
  });

  it("truncates ordinary, fast traffic", () => {
    expect(isNotableSnapshot({ a: { sc: 200 }, d: 12 })).toBe(false);
    expect(isNotableSnapshot({})).toBe(false);
  });

  it("agrees with the collector on the boundary", () => {
    // Strictly greater, like the server's `duration > NOTABLE_TRACE_DURATION_MS`.
    expect(isNotableSnapshot({ d: NOTABLE_DURATION_MS })).toBe(false);
    expect(isNotableSnapshot({ a: { sc: 499 } })).toBe(false);
    expect(isNotableSnapshot({ a: { sc: 500 } })).toBe(true);
  });
});

describe("what a paused account still sends", () => {
  it("sends a server error, error object or not", () => {
    expect(isServerErrorSnapshot({ a: { sc: 503 } })).toBe(true);
    expect(
      isServerErrorSnapshot({ a: { sc: 500 }, e: { message: "boom" } }),
    ).toBe(true);
  });

  it("sends an errored execution that carries no status code", () => {
    // A job, or a non-HTTP entry point: nothing grades these but the error.
    expect(isServerErrorSnapshot({ e: { message: "boom" } })).toBe(true);
    expect(isServerErrorSnapshot({ a: {}, e: { message: "boom" } })).toBe(true);
  });

  it("withholds a slow execution, which is notable and still no server error", () => {
    // The half of the notable rule a pause leaves out.
    type Execution = Parameters<typeof isNotableSnapshot>[0];
    const slowSuccess: Execution = {
      a: { sc: 200 },
      d: NOTABLE_DURATION_MS * 30,
    };
    const slowJob: Execution = { d: NOTABLE_DURATION_MS * 30 };

    expect(isNotableSnapshot(slowSuccess)).toBe(true);
    expect(isServerErrorSnapshot(slowSuccess)).toBe(false);
    expect(isNotableSnapshot(slowJob)).toBe(true);
    expect(isServerErrorSnapshot(slowJob)).toBe(false);
  });

  it("lets a status code decide alone where there is one", () => {
    // 401s and 429s are most of the daily error count, each with an error
    // object, and a flood of them is a common spike.
    expect(
      isServerErrorSnapshot({ a: { sc: 401 }, e: { message: "no" } }),
    ).toBe(false);
    expect(
      isServerErrorSnapshot({ a: { sc: 429 }, e: { message: "no" } }),
    ).toBe(false);
  });

  it("withholds ordinary traffic, and an execution with no error or status", () => {
    expect(isServerErrorSnapshot({ a: { sc: 200 } })).toBe(false);
    expect(isServerErrorSnapshot({})).toBe(false);
  });

  it("agrees with the collector on the boundary", () => {
    expect(isServerErrorSnapshot({ a: { sc: 499 } })).toBe(false);
    expect(isServerErrorSnapshot({ a: { sc: 500 } })).toBe(true);
  });
});

describe("the shared buffer's degraded window", () => {
  const windowOf = () =>
    new ObserveAgentSharedBuffer({
      serviceId: "svc",
    } as ObserveModuleOptionsWithDefaults);

  it("starts clear, so the first batch after start-up carries its spans", () => {
    expect(windowOf().isDegraded()).toBe(false);
    expect(windowOf().isErrorsOnly()).toBe(false);
  });

  it.each(["reduced", "errors-only"] as const)(
    "lapses on its own rather than needing a restart (`%s`)",
    (mode) => {
      // The collector cannot announce the end of degradation - an upgrade, the
      // turn of the period or a resumed pause simply starts keeping spans
      // again - so the window has to expire by itself.
      vi.useFakeTimers();
      try {
        const window = windowOf();
        window.setIngestMode(mode);
        expect(window.isDegraded()).toBe(true);
        expect(window.isErrorsOnly()).toBe(mode === "errors-only");

        vi.advanceTimersByTime(DEGRADED_TTL_MS + 1);
        expect(window.isDegraded()).toBe(false);
        expect(window.isErrorsOnly()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("clears immediately when a batch comes back undegraded", () => {
    const window = windowOf();
    window.setIngestMode("reduced");
    window.setIngestMode("full");

    expect(window.isDegraded()).toBe(false);
  });

  it.each(["full", "reduced", "trimmed", "paced"] as const)(
    "ends errors-only at once when a reply says `%s` instead",
    (mode) => {
      const window = windowOf();
      window.setIngestMode("errors-only");
      window.setIngestMode(mode);

      expect(window.isErrorsOnly()).toBe(false);
      expect(window.isDegraded()).toBe(mode !== "full");
    },
  );
});

describe("counting what was withheld", () => {
  it("counts every node, not every root", () => {
    /*
     * The meter bills a trace by its node count. On an auto-instrumented
     * request a single root routinely carries eighty-odd children, so counting
     * roots would report a fraction of what was withheld and measure the
     * account against the wrong volume.
     */
    const tree = [{ ch: [{ ch: [{}] }, {}] }, { ch: [] }];

    expect(countTraceNodes(tree)).toBe(5);
  });

  it("treats a missing or malformed tree as nothing", () => {
    expect(countTraceNodes(undefined)).toBe(0);
    expect(countTraceNodes(null)).toBe(0);
    expect(countTraceNodes({})).toBe(0);
    expect(countTraceNodes([])).toBe(0);
  });
});
