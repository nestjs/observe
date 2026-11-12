import {
  endOperation,
  liveTraceId,
  OPERATION_GRACE_MS,
  OPERATION_STATE_KEY,
  OperationState,
  openOperation,
} from "./operation-state.util.js";

describe("liveTraceId", () => {
  const storeWith = (traceId: unknown) =>
    new Map<string, unknown>([["traceId", traceId]]);

  it("hands on the id of an operation that is still running", () => {
    const store = storeWith("t-1");
    openOperation(store);

    expect(liveTraceId(store, "traceId")).toBe("t-1");
  });

  it("keeps it for the grace period after the operation ended", () => {
    const store = storeWith("t-1");
    endOperation(openOperation(store));

    expect(liveTraceId(store, "traceId")).toBe("t-1");
  });

  it("hands on nothing once the grace period is over", () => {
    // A flush interval a request armed lazily, firing long after the
    // request was answered.
    const store = storeWith("t-1");
    const operation = openOperation(store);
    operation.endedAt = performance.now() - OPERATION_GRACE_MS - 1;

    expect(liveTraceId(store, "traceId")).toBeUndefined();
  });

  it("reaches every copy of the store a span runs in", () => {
    const store = storeWith("t-1");
    const operation = openOperation(store);
    const spanStore = new Map(store);
    operation.endedAt = performance.now() - OPERATION_GRACE_MS - 1;

    expect(liveTraceId(spanStore, "traceId")).toBeUndefined();
  });

  it("counts only the first end", () => {
    const operation: OperationState = {};
    endOperation(operation);
    const first = operation.endedAt;
    endOperation(operation);

    expect(operation.endedAt).toBe(first);
  });

  it("treats a store with no operation state as running, and no id as none", () => {
    expect(liveTraceId(storeWith("t-1"), "traceId")).toBe("t-1");
    expect(liveTraceId(storeWith(42), "traceId")).toBeUndefined();
    expect(liveTraceId(undefined, "traceId")).toBeUndefined();
    expect(storeWith("t-1").has(OPERATION_STATE_KEY)).toBe(false);
  });
});
