import { ConsoleLogger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";
import { StdoutForwarderService } from "./stdout-forwarder.service.js";

interface CapturedEntry {
  text: string;
  traceId?: string;
  spanId?: string;
  level?: string;
  context?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Collects entries instead of buffering them for the agent thread.
 *
 * Substituted for the shared buffer so a test can read exactly what the
 * forwarder decided to ship - which is the whole subject here, since everything
 * this service does happens on the way into that buffer.
 */
class CapturingBuffer {
  readonly entries: CapturedEntry[] = [];

  pushLogs(logs: CapturedEntry[]) {
    this.entries.push(...logs);
  }
}

const TRACE_ID_KEY = "traceId";

describe("StdoutForwarderService", () => {
  let buffer: CapturingBuffer;
  let als: AsyncLocalStorage<Map<string, any>>;

  const build = (options: Partial<ObserveModuleOptionsWithDefaults> = {}) => {
    buffer = new CapturingBuffer();
    als = new AsyncLocalStorage();
    return new StdoutForwarderService(
      {
        traceIdKey: TRACE_ID_KEY,
        // Left off so the constructor does not patch process.stdout for the
        // whole run: tests that want the patch call `start()` and restore it.
        forwardLogs: false,
        ...options,
      } as ObserveModuleOptionsWithDefaults,
      buffer as unknown as ObserveAgentSharedBuffer,
      als,
    );
  };

  /** Feeds a chunk through the same path a stdout write takes. */
  const write = (
    service: StdoutForwarderService,
    chunk: string,
    stream: "stdout" | "stderr" = "stdout",
  ) =>
    (
      service as unknown as {
        consume(chunk: string, stream: "stdout" | "stderr"): void;
      }
    ).consume(chunk, stream);

  describe("chunk reassembly", () => {
    it("forwards a complete line", () => {
      const service = build();

      write(service, "hello world\n");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "hello world",
      ]);
    });

    it("forwards several lines from one chunk", () => {
      const service = build();

      write(service, "first\nsecond\nthird\n");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("holds a line split across two writes until its newline arrives", () => {
      const service = build();

      write(service, "split ");
      // stdout arrives in chunks, not lines - parsing the chunk directly would
      // mangle every log that straddles a boundary.
      expect(buffer.entries).toHaveLength(0);

      write(service, "across writes\n");
      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "split across writes",
      ]);
    });

    it("emits the complete lines in a chunk and holds the trailing fragment", () => {
      const service = build();

      write(service, "done\npartial");

      expect(buffer.entries.map((entry) => entry.text)).toEqual(["done"]);

      write(service, " finished\n");
      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "done",
        "partial finished",
      ]);
    });

    it("ignores blank lines", () => {
      const service = build();

      write(service, "\n\n   \n\n");

      expect(buffer.entries).toHaveLength(0);
    });

    it("forwards an over-long fragment rather than growing without bound", () => {
      const service = build();

      // A progress bar or a streamed response writes indefinitely without a
      // newline; a partial line is still evidence, so it is shipped at the cap
      // rather than discarded.
      write(service, "x".repeat(9 * 1024));

      expect(buffer.entries).toHaveLength(1);
      expect(buffer.entries[0].text.length).toBeGreaterThan(8 * 1024);
    });
  });

  describe("parsing", () => {
    it("carries level and context through from a Nest line", () => {
      const service = build();

      write(
        service,
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     WARN [OrdersService] slow query\n",
      );

      expect(buffer.entries[0]).toMatchObject({
        level: "warn",
        context: "OrdersService",
        text: "slow query",
      });
    });

    it("forwards an unrecognised line with its full text", () => {
      const service = build();

      write(service, "npm warn deprecated foo@1.0.0\n");

      // A log the agent does not understand is still the log someone is
      // looking for.
      expect(buffer.entries[0].text).toBe("npm warn deprecated foo@1.0.0");
    });

    it("stamps every entry with a timestamp", () => {
      const service = build();

      write(service, "anything\n");

      expect(
        (buffer.entries[0] as unknown as { timestamp: number }).timestamp,
      ).toEqual(expect.any(Number));
    });
  });

  describe("trace attribution", () => {
    it("takes the trace and span from the async store", () => {
      const service = build();

      als.run(
        new Map([
          [TRACE_ID_KEY, "trace-from-store"],
          [CALLER_METADATA_KEY, "span-1"],
        ]),
        () => write(service, "inside a span\n"),
      );

      expect(buffer.entries[0]).toMatchObject({
        traceId: "trace-from-store",
        spanId: "span-1",
      });
    });

    it("prefers a trace id carried on the line itself", () => {
      const service = build();

      als.run(new Map([[TRACE_ID_KEY, "trace-from-store"]]), () =>
        write(
          service,
          "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: trace-on-line\n",
        ),
      );

      // The line's id was captured when the log was written; the store is read
      // now and may already have moved on.
      expect(buffer.entries[0].traceId).toBe("trace-on-line");
    });

    it("drops the span id when the line belongs to a different trace", () => {
      const service = build();

      als.run(
        new Map([
          [TRACE_ID_KEY, "trace-from-store"],
          [CALLER_METADATA_KEY, "span-of-other-operation"],
        ]),
        () =>
          write(
            service,
            "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: trace-on-line\n",
          ),
      );

      // Naming the store's span here would file the line under a span it was
      // never written inside.
      expect(buffer.entries[0].spanId).toBeUndefined();
    });

    it("forwards a line written outside any trace", () => {
      const service = build();

      write(service, "no async context here\n");

      expect(buffer.entries[0].traceId).toBeUndefined();
      expect(buffer.entries[0].spanId).toBeUndefined();
    });
  });

  describe("redaction", () => {
    it("redacts the message before it reaches the buffer", () => {
      const service = build();

      write(service, "signing in with password=hunter2\n");

      // Before the buffer, which is also before the buffer truncates oversized
      // lines - truncating first would cut a long secret in half and ship the
      // surviving half.
      expect(buffer.entries[0].text).not.toContain("hunter2");
    });

    it("redacts attributes on a structured line", () => {
      const service = build();

      write(
        service,
        `${JSON.stringify({
          level: "info",
          message: "auth attempt",
          password: "hunter2",
        })}\n`,
      );

      expect(JSON.stringify(buffer.entries[0])).not.toContain("hunter2");
    });

    it("is on by default, because forwarding moves logs onto another machine", () => {
      const service = build({ redaction: undefined });

      write(service, "token=abcdef123456\n");

      expect(buffer.entries[0].text).not.toContain("abcdef123456");
    });

    it("can be switched off explicitly", () => {
      const service = build({ redaction: { enabled: false } });

      write(service, "password=hunter2\n");

      expect(buffer.entries[0].text).toContain("hunter2");
    });

    it("honours custom redaction options", () => {
      const service = build({
        redaction: { replacement: "***" },
      });

      write(service, "password=hunter2\n");

      expect(buffer.entries[0].text).toContain("***");
    });
  });

  describe("patching stdout", () => {
    it("forwards writes and leaves stdout working", () => {
      const service = build();
      const original = process.stdout.write;

      service.start();
      try {
        expect(process.stdout.write).not.toBe(original);
        process.stdout.write("patched line\n");
      } finally {
        service.onModuleDestroy();
      }

      // Exactly the original reference, not a bound copy of it: repeated
      // start/restore cycles must not leave a stack of `bind` wrappers behind.
      expect(process.stdout.write).toBe(original);
      expect(buffer.entries.map((entry) => entry.text)).toContain(
        "patched line",
      );
    });

    it("forwards stderr too, so error lines are not lost", () => {
      const service = build();
      // ConsoleLogger writes `error` to stderr and every other level to stdout.
      const logger = new ConsoleLogger("Payments", { json: true });
      // A no-op underneath the patch keeps the stack trace out of the test
      // output while still exercising the real wrapper.
      const realStderr = process.stderr.write;
      const silent = (() => true) as typeof process.stderr.write;
      process.stderr.write = silent;

      try {
        service.start();
        expect(process.stderr.write).not.toBe(silent);
        logger.error("charge failed", new Error("declined").stack);
        service.onModuleDestroy();
        expect(process.stderr.write).toBe(silent);
      } finally {
        process.stderr.write = realStderr;
      }

      expect(
        buffer.entries.map((entry) => [entry.level, entry.text]),
      ).toContainEqual(["error", "charge failed"]);
    });

    it("keeps a fragment on stdout apart from one on stderr", () => {
      const service = build();

      write(service, "half of stdout ", "stdout");
      write(service, "half of stderr ", "stderr");
      write(service, "done\n", "stdout");
      write(service, "done\n", "stderr");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "half of stdout done",
        "half of stderr done",
      ]);
    });

    it("does not patch twice", () => {
      const service = build();

      service.start();
      const patched = process.stdout.write;
      service.start();

      try {
        expect(process.stdout.write).toBe(patched);
      } finally {
        service.onModuleDestroy();
      }
    });

    it("keeps stdout working when forwarding throws", () => {
      const service = build();
      vi.spyOn(buffer, "pushLogs").mockImplementation(() => {
        throw new Error("buffer exploded");
      });

      service.start();
      try {
        // A forwarding failure must never take down the write it wrapped, and
        // logging the failure here would re-enter this same patched write.
        expect(() => process.stdout.write("still works\n")).not.toThrow();
      } finally {
        service.onModuleDestroy();
      }
    });

    it("flushes a held fragment on shutdown", () => {
      const service = build();

      service.start();
      process.stdout.write("no newline yet");
      service.onModuleDestroy();

      // Otherwise the last thing a crashing process wrote is the thing that
      // never arrives.
      expect(buffer.entries.map((entry) => entry.text)).toContain(
        "no newline yet",
      );
    });

    it("survives repeated start and restore cycles", () => {
      const original = process.stdout.write;
      const originalStderr = process.stderr.write;

      for (let i = 0; i < 3; i++) {
        const service = build();
        service.start();
        service.onModuleDestroy();
      }

      expect(process.stdout.write).toBe(original);
      expect(process.stderr.write).toBe(originalStderr);
    });

    it("restores stdout even if it was never patched", () => {
      const service = build();
      const original = process.stdout.write;

      expect(() => service.onModuleDestroy()).not.toThrow();
      expect(process.stdout.write).toBe(original);
    });
  });
});
