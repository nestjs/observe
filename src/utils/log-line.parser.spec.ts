import { parseLogLine, stripAnsi } from "./log-line.parser.js";

/**
 * Anything that writes to stdout ends up in this path, so the parser has to cope
 * with three shapes at once: Nest's JSON logger, its text logger, and lines that
 * are neither. The governing rule is that nothing is dropped for being
 * unparseable - a log the agent does not understand is still the log someone is
 * looking for.
 */
describe("parseLogLine", () => {
  describe("structured JSON lines", () => {
    it("maps the modelled fields", () => {
      const parsed = parseLogLine(
        JSON.stringify({
          level: "warn",
          message: "disk almost full",
          context: "HealthService",
          traceId: "trace-1",
        }),
      );

      expect(parsed).toMatchObject({
        level: "warn",
        message: "disk almost full",
        context: "HealthService",
        traceId: "trace-1",
      });
    });

    it("keeps unmodelled keys as attributes", () => {
      const parsed = parseLogLine(
        JSON.stringify({
          level: "info",
          message: "order placed",
          orderId: "o-1",
          amount: 42,
        }),
      );

      expect(parsed.attributes).toMatchObject({ orderId: "o-1", amount: 42 });
      // Fields that have their own column must not be duplicated into the blob.
      expect(parsed.attributes).not.toHaveProperty("message");
      expect(parsed.attributes).not.toHaveProperty("level");
    });

    it("does not treat arbitrary JSON as a log record", () => {
      const line = JSON.stringify([1, 2, 3]);

      expect(parseLogLine(line).message).toBe(line);
    });

    it("falls back to the raw line for malformed JSON", () => {
      const line = '{"level":"info","message":';

      expect(parseLogLine(line).message).toBe(line);
    });

    it.each([
      ["info", "log"],
      ["INFO", "log"],
      ["warning", "warn"],
      ["trace", "verbose"],
      ["Error", "error"],
    ])("maps the level %s onto %s", (written, mapped) => {
      const parsed = parseLogLine(
        JSON.stringify({ level: written, message: "order placed" }),
      );

      // The collector accepts Nest's levels only, and refuses the whole batch
      // - traces and metrics included - over any other.
      expect(parsed.level).toBe(mapped);
    });

    it("keeps a level the collector does not model as an attribute", () => {
      const named = parseLogLine(
        JSON.stringify({ level: "notice", message: "disk at 80%" }),
      );
      const numeric = parseLogLine(
        JSON.stringify({ level: 30, message: "disk at 80%" }),
      );

      // It cannot ride in `level`, but it is still what the line said.
      expect(named.level).toBeUndefined();
      expect(named.attributes).toEqual({ level: "notice" });
      expect(numeric.level).toBeUndefined();
      expect(numeric.attributes).toEqual({ level: 30 });
    });
  });

  describe("Nest text lines", () => {
    it("extracts level, context and message", () => {
      const parsed = parseLogLine(
        "[Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG [AppController] handling request",
      );

      // The level is normalised to lower case, matching the LogLevel the
      // ingestion DTO accepts.
      expect(parsed).toMatchObject({
        level: "log",
        context: "AppController",
        message: "handling request",
      });
    });

    it("copes with a line that has no context bracket", () => {
      // `logger.log()` without a context omits it entirely.
      const parsed = parseLogLine(
        "[Nest] 1234  - 07/29/2026, 10:42:18 AM     WARN something happened",
      );

      expect(parsed.level).toBe("warn");
      expect(parsed.message).toBe("something happened");
      expect(parsed.context).toBeUndefined();
    });

    it.each([
      ["FATAL", "fatal"],
      ["ERROR", "error"],
      ["WARN", "warn"],
      ["LOG", "log"],
      ["DEBUG", "debug"],
      ["VERBOSE", "verbose"],
    ])("recognises %s and normalises it to %s", (printed, normalised) => {
      const parsed = parseLogLine(
        `[Nest] 1  - 07/29/2026, 10:42:18 AM     ${printed} [Ctx] message`,
      );

      expect(parsed.level).toBe(normalised);
    });

    it("recognises VERBOSE as Nest prints it", () => {
      // Nest right-aligns the level in seven columns, and VERBOSE fills all
      // seven - one space after the timestamp, where every other level gets
      // several.
      const parsed = parseLogLine(
        "[Nest] 1234  - 07/29/2026, 10:42:18 AM VERBOSE [CacheService] warmed",
      );

      expect(parsed).toMatchObject({
        level: "verbose",
        context: "CacheService",
        message: "warmed",
      });
    });

    it("keeps a multi-line message intact", () => {
      const parsed = parseLogLine(
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     ERROR [Ctx] failed\n  at foo\n  at bar",
      );

      // A stack trace is the most valuable part of an error line; truncating at
      // the first newline would discard it.
      expect(parsed.message).toContain("at foo");
      expect(parsed.message).toContain("at bar");
    });

    it("recovers a trace id appended as a suffix", () => {
      const parsed = parseLogLine(
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: abc-123",
      );

      // The async context may be gone by the time the forwarder sees the line,
      // so the suffix is how the trace survives.
      expect(parsed.traceId).toBe("abc-123");
      expect(parsed.message).not.toContain("Trace ID");
    });

    it.each([
      ["no space after the marker", "done Trace ID:abc-123", "done"],
      ["nothing before the marker", "Trace ID: abc-123", ""],
      [
        "an earlier marker in the message",
        "retried Trace ID: old Trace ID: abc-123",
        "retried Trace ID: old",
      ],
    ])("recovers the suffix with %s", (_, rest, message) => {
      const parsed = parseLogLine(
        `[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] ${rest}`,
      );

      expect(parsed.traceId).toBe("abc-123");
      expect(parsed.message).toBe(message);
    });

    it("leaves a marker followed by more than one token in the message", () => {
      const parsed = parseLogLine(
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] see Trace ID: abc for details",
      );

      // Only a suffix is the logger's; this is the message talking.
      expect(parsed.traceId).toBeUndefined();
      expect(parsed.message).toBe("see Trace ID: abc for details");
    });
  });

  describe("pathological lines", () => {
    /**
     * Parsing runs synchronously inside `process.stdout.write`, so its cost is
     * the event loop's - and whoever gets text into a logged value shapes the
     * line. Every case here held the loop under the patterns this replaced.
     */
    const expectLinear = (line: string) => {
      const startedAt = performance.now();

      parseLogLine(line);

      expect(performance.now() - startedAt).toBeLessThan(250);
    };

    it.each([
      ["spaces", " "],
      ["tabs", "\t"],
    ])("rejects a [Nest] line that runs into %s in linear time", (_, unit) => {
      // Cubic under the pattern this replaced: ~15s for this input.
      expectLinear(`[Nest] 1 - ${unit.repeat(3_000)}x`);
    });

    it("parses a level line carrying a long run of whitespace in linear time", () => {
      // Quadratic under the trace id pattern this replaced: ~9s for this input.
      expectLinear(
        `[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] q=${" ".repeat(64_000)}x`,
      );
    });

    it("parses a VERBOSE line carrying a long run of whitespace in linear time", () => {
      // Quadratic under the pattern this replaced, which never found the level
      // and scanned the whole run for one: ~8s for this input.
      expectLinear(
        `[Nest] 1  - 07/29/2026, 10:42:18 AM VERBOSE [Ctx] q=${" ".repeat(64_000)}x`,
      );
    });
  });

  describe("unrecognised lines", () => {
    it.each([
      "plain stdout output",
      "  ",
      "npm warn deprecated package@1.0.0",
      "> observe-api@1.0.0 start",
    ])("forwards %s with its full text as the message", (line) => {
      expect(parseLogLine(line).message).toBe(line.trimEnd());
    });

    it("never returns undefined for the message", () => {
      for (const line of ["", "{}", "[]", "null", "[Nest]"]) {
        expect(typeof parseLogLine(line).message).toBe("string");
      }
    });
  });

  describe("a bracket read as the context", () => {
    it("is kept in one piece with the message as well", () => {
      // Only a guess at a context: `Logger.log("[1, 2] done")` prints the
      // same line. Whoever redacts the halves needs the whole.
      expect(
        parseLogLine(
          "[Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG [1, 2]  done Trace ID: abc-123",
        ),
      ).toMatchObject({
        context: "1, 2",
        message: "done",
        unsplit: "[1, 2]  done",
        traceId: "abc-123",
      });
    });

    it("is not there for a line without one", () => {
      expect(
        parseLogLine("[Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG done")
          .unsplit,
      ).toBeUndefined();
    });
  });

  describe("format", () => {
    it("says what a line was read as", () => {
      expect(parseLogLine('{"level":"info","message":"ready"}').format).toBe(
        "json",
      );
      expect(
        parseLogLine("[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG ready")
          .format,
      ).toBe("nest");
      expect(parseLogLine("    at main (main.ts:4:9)").format).toBe("plain");
      // JSON, but not a log record: the text path has it.
      expect(parseLogLine('{"status":"ok"}').format).toBe("plain");
    });
  });

  describe("ANSI handling", () => {
    it("strips colour codes", () => {
      expect(stripAnsi("[32mgreen[39m")).toBe("green");
    });

    it("removes colour before parsing", () => {
      const parsed = parseLogLine(
        "[32m[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG[39m [Ctx] coloured",
      );

      expect(parsed.level).toBe("log");
      expect(parsed.message).toBe("coloured");
    });

    it("leaves ordinary text alone", () => {
      // A tighter pattern than a general ANSI stripper, so it cannot eat real
      // log content that happens to contain brackets.
      expect(stripAnsi("array[0] and cost[USD]")).toBe(
        "array[0] and cost[USD]",
      );
    });
  });
});
