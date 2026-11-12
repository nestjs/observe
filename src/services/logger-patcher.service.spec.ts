import { ConsoleLogger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { nestMajor } from "../testing/nest-version.js";
import { LoggerPatcherService } from "./logger-patcher.service.js";
import { StdoutForwarderService } from "./stdout-forwarder.service.js";

const TRACE_ID_KEY = "traceId";
const options = {
  traceIdKey: TRACE_ID_KEY,
  attachTraceIdToLogs: true,
  forwardLogs: false,
} as ObserveModuleOptionsWithDefaults;

/**
 * The patch lives on `ConsoleLogger.prototype` and is guarded by a
 * non-configurable watermark, so it is applied once per file and cannot be
 * undone. Every test shares this store for that reason: a second patcher with
 * its own store would be a no-op.
 */
const als = new AsyncLocalStorage<Map<string, any>>();

const inTrace = <T>(traceId: string, fn: () => T) =>
  als.run(new Map([[TRACE_ID_KEY, traceId]]), fn);

/**
 * Nest 12 writes a message's structured params on the message's line, and can
 * flatten them into its JSON entry; Nest 11 writes each param as an entry of
 * its own. The cases built on Nest 12's layout run from 12 on - what the text
 * ones guard, a wrapper dropping Nest 12's seventh `formatMessage` argument,
 * cannot happen before it.
 */
const itFromNest12 = it.runIf(nestMajor >= 12);

/** Everything the logger wrote to stdout while `fn` ran. */
function captureStdout(fn: () => void): string {
  let written = "";
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return written;
}

describe("LoggerPatcherService", () => {
  beforeAll(() => {
    new LoggerPatcherService(als, options).onModuleInit();
  });

  describe("text output", () => {
    const logger = () => new ConsoleLogger("Payments", { colors: false });

    itFromNest12("keeps structured params outside a trace", () => {
      const output = captureStdout(() =>
        logger().warn("declined", { orderId: "ord_1" }),
      );

      expect(output).toContain("declined { orderId: 'ord_1' }");
      expect(output).not.toContain("Trace ID");
    });

    itFromNest12("keeps structured params inside a trace", () => {
      const output = captureStdout(() =>
        inTrace("abc123", () =>
          logger().warn("declined", { orderId: "ord_1" }),
        ),
      );

      expect(output).toContain("declined { orderId: 'ord_1' }");
    });

    it("puts the trace id on the log line, not on a line of its own", () => {
      const output = captureStdout(() =>
        inTrace("abc123", () => logger().log("hello")),
      );

      expect(output.split("\n")).toEqual([
        expect.stringMatching(/LOG \[Payments\] hello\s+Trace ID: abc123$/),
        "",
      ]);
    });
  });

  describe("JSON output", () => {
    it("adds the trace id as a field", () => {
      const output = captureStdout(() =>
        inTrace("abc123", () =>
          new ConsoleLogger("Payments", { json: true }).warn("declined"),
        ),
      );

      expect(JSON.parse(output)).toMatchObject({
        level: "warn",
        message: "declined",
        traceId: "abc123",
      });
    });

    itFromNest12("adds the trace id beside flattened params", () => {
      const output = captureStdout(() =>
        inTrace("abc123", () =>
          new ConsoleLogger("Payments", {
            json: true,
            flattenParams: true,
          }).warn("declined", { orderId: "ord_1" }),
        ),
      );

      expect(JSON.parse(output)).toMatchObject({
        level: "warn",
        message: "declined",
        orderId: "ord_1",
        traceId: "abc123",
      });
    });
  });

  describe("through the stdout forwarder", () => {
    // Real patched output rather than a hand-written fixture: the fixtures had
    // the id on the log line, which is exactly what the patch did not produce.
    it("yields one entry carrying its trace id, level and message", () => {
      const entries: Array<Record<string, unknown>> = [];
      const forwarder = new StdoutForwarderService(
        options,
        {
          pushLogs: (logs: Array<Record<string, unknown>>) =>
            entries.push(...logs),
        } as unknown as ObserveAgentSharedBuffer,
        // A separate, empty store: the id has to come off the line itself, as
        // it does when the async context has moved on by the time of the write.
        new AsyncLocalStorage(),
      );

      const output = captureStdout(() =>
        inTrace("abc123", () =>
          new ConsoleLogger("Payments", { colors: false }).log("hello"),
        ),
      );
      (forwarder as unknown as { consume(chunk: string): void }).consume(
        output,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        level: "log",
        context: "Payments",
        text: "hello",
        traceId: "abc123",
      });
    });
  });
});
