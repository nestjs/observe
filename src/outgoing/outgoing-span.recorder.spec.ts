import { AsyncLocalStorage } from "node:async_hooks";
import { TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";

describe("OutgoingSpanRecorder.isRecording", () => {
  const setup = () => {
    const storage = new AsyncLocalStorage<Map<any, any>>();
    const registry = new OperationTraceRegistry(storage, false);
    const recorder = new OutgoingSpanRecorder(registry, storage, "traceId");
    registry.startTrace("request-1", {} as never);
    return { storage, registry, recorder };
  };

  it("agrees with open() about whether a span would be attached", () => {
    const { storage, recorder } = setup();
    const answers = (store?: Map<any, any>) => {
      const ask = () => {
        const recording = recorder.isRecording();
        const span = recorder.open("mssql", "SELECT 1", {});
        span?.end();
        return [recording, span !== undefined];
      };
      return store ? storage.run(store, ask) : ask();
    };

    // No traced operation in this context.
    expect(answers()).toEqual([false, false]);
    // Under the registry key, and under the reported trace id it falls back to.
    expect(answers(new Map([[TRACE_REGISTRY_KEY, "request-1"]]))).toEqual([
      true,
      true,
    ]);
    expect(answers(new Map([["traceId", "request-1"]]))).toEqual([true, true]);
    // A trace that was never started here: sampled out, or already shipped.
    expect(answers(new Map([[TRACE_REGISTRY_KEY, "request-2"]]))).toEqual([
      false,
      false,
    ]);
  });

  it("is false inside a call an outer entry point already covers", () => {
    const { storage, recorder } = setup();
    storage.run(new Map([[TRACE_REGISTRY_KEY, "request-1"]]), () => {
      expect(recorder.cover(() => recorder.isRecording())).toBe(false);
      expect(recorder.isRecording()).toBe(true);
    });
  });
});

describe("OutgoingSpanRecorder.endWhenSettled", () => {
  const recorder = new OutgoingSpanRecorder(
    new OperationTraceRegistry(new AsyncLocalStorage(), false),
    new AsyncLocalStorage(),
    "traceId",
  );
  const failingSpan = {
    spanId: "span-1",
    end: () => {
      throw new Error("span bookkeeping failed");
    },
  };

  it("keeps a span that fails to close out of the call's outcome", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(recorder.endWhenSettled(failingSpan, "rows")).toBe("rows");
      await expect(
        recorder.endWhenSettled(failingSpan, Promise.resolve("rows")),
      ).resolves.toBe("rows");
      const failed = Promise.reject(new Error("query failed"));
      failed.catch(() => undefined);
      recorder.endWhenSettled(failingSpan, failed);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
