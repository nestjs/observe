import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { CustomMetric } from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import {
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "./operation-trace.registry.js";
import { TracerService } from "./tracer.service.js";

/**
 * The public API of the agent - what application code actually calls.
 *
 * Two things matter beyond the obvious. Metrics are registry-backed: calling
 * `counter("orders")` twice must hand back the *same* counter, or every call
 * site accumulates its own total and the reported figure is whichever one
 * flushed last. Trace methods also depend on the async store: methods that
 * require a context fail clearly, while optional accessors and naming are safe
 * outside a recorded operation.
 */
describe("TracerService", () => {
  const TRACE_ID_KEY = "traceId";

  let als: AsyncLocalStorage<Map<string, unknown>>;
  let registry: OperationTraceRegistry;
  let upserted: CustomMetric[];
  let tracer: TracerService;

  beforeEach(() => {
    als = new AsyncLocalStorage();
    registry = new OperationTraceRegistry(als as never, false);
    upserted = [];

    const buffer = {
      upsertCustomMetric: (metric: CustomMetric) => upserted.push(metric),
    } as unknown as ObserveAgentSharedBuffer;

    tracer = new TracerService(registry, als as never, buffer, {
      traceIdKey: TRACE_ID_KEY,
    } as ObserveModuleOptionsWithDefaults);
  });

  /** Runs `fn` as though inside an instrumented request with one open span. */
  const inTrace = async <T>(
    traceId: string,
    fn: (spanId: string) => Promise<T> | T,
  ): Promise<T> => {
    registry.startTrace(traceId, {
      operationId: "GET /orders",
      protocol: "http",
      attributes: { method: "GET", originalUrl: "/orders" },
      tags: {},
    });
    const spanId = registry.internalStartTraceStep(
      traceId,
      "OrdersController",
      "findAll",
      undefined,
    );
    // The trace was started two lines up, so the step always opens.
    expect(spanId).toBeDefined();

    return als.run(
      new Map<string, unknown>([
        [TRACE_ID_KEY, traceId],
        [CALLER_METADATA_KEY, spanId!],
      ]),
      () => fn(spanId!),
    );
  };

  describe("createSpan", () => {
    it("runs the callback and returns its value", async () => {
      const result = await inTrace("t1", () =>
        tracer.createSpan("work", () => "done"),
      );

      expect(result).toBe("done");
    });

    it("awaits an async callback", async () => {
      const result = await inTrace("t2", () =>
        tracer.createSpan("async work", async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return "eventually";
        }),
      );

      expect(result).toBe("eventually");
    });

    it("records the span on the trace under the caller", async () => {
      await inTrace("t3", async (spanId) => {
        await tracer.createSpan("child work", () => "ok");
        registry.internalEndTraceStep("t3", spanId, "C", "m", spanId);
      });
      registry.endTrace("t3");

      const snapshot = await registry.pluckSnapshot("t3");
      const root = snapshot!.traces[0] as {
        children?: Array<{ name?: string; origin?: string }>;
      };
      expect(root.children?.[0]).toMatchObject({
        name: "child work",
        origin: "manual",
      });
    });

    it("re-throws from the callback", async () => {
      await expect(
        inTrace("t4", () =>
          tracer.createSpan("failing", () => {
            throw new Error("inner boom");
          }),
        ),
      ).rejects.toThrow("inner boom");
    });

    it("hands the callback a delegate that can tag the span", async () => {
      await inTrace("t5", async (spanId) => {
        await tracer.createSpan("tagged", (span) => {
          span.addTags({ orderId: "o-1" });
          return "ok";
        });
        registry.internalEndTraceStep("t5", spanId, "C", "m", spanId);
      });
      registry.endTrace("t5");

      const snapshot = await registry.pluckSnapshot("t5");
      const root = snapshot!.traces[0] as {
        children?: Array<{ tags?: Record<string, unknown> }>;
      };
      expect(root.children?.[0].tags).toMatchObject({ orderId: "o-1" });
    });

    it("fails clearly when called outside any async context", async () => {
      // Without this the trace id would be `undefined` and the span would be
      // filed against a trace that does not exist.
      await expect(tracer.createSpan("orphan", () => "x")).rejects.toThrow(
        /AsyncLocalStorage is not initialized/,
      );
    });
  });

  describe("currentTraceId", () => {
    it("returns the trace id in scope", async () => {
      const traceId = await inTrace("id1", () => tracer.currentTraceId());

      expect(traceId).toBe("id1");
    });

    it("returns null outside any async context", () => {
      // Reading the id to forward downstream is exactly the kind of call that
      // may legitimately happen outside a traced context, so this must not
      // throw the way the other accessors do.
      expect(tracer.currentTraceId()).toBeNull();
    });

    it("returns null when the store exists but carries no trace id", () => {
      expect(als.run(new Map(), () => tracer.currentTraceId())).toBeNull();
    });
  });

  describe("setAttribute and getAttribute", () => {
    it("takes any key when the store is not typed", () => {
      als.run(new Map(), () => {
        tracer.setAttribute("userId", "42");
        tracer.setAttribute("flags.betaCheckout", true);

        expect(tracer.getAttribute("userId")).toBe("42");
        expect(tracer.getAttribute("flags.betaCheckout")).toBe(true);
        expectTypeOf(tracer.getAttribute("userId")).toEqualTypeOf<unknown>();
      });
    });

    it("checks keys and values against a store declared as an interface", () => {
      interface RequestStore {
        userId: number;
        flags: { betaCheckout: boolean };
      }
      const typedTracer = new TracerService<RequestStore>(
        registry,
        als as never,
        {} as ObserveAgentSharedBuffer,
        { traceIdKey: TRACE_ID_KEY } as ObserveModuleOptionsWithDefaults,
      );

      als.run(new Map(), () => {
        // @ts-expect-error the store says userId is a number
        typedTracer.setAttribute("userId", "7");
        // @ts-expect-error the store has no such key
        typedTracer.setAttribute("tenantId", "acme");
        typedTracer.setAttribute("userId", 7);
        typedTracer.setAttribute("flags.betaCheckout", true);

        expect(typedTracer.getAttribute("userId")).toBe(7);
        expectTypeOf(typedTracer.getAttribute("userId")).toEqualTypeOf<
          number | undefined
        >();
      });
    });
  });

  describe("setOperationId", () => {
    it("renames the active request using the configured trace id key", async () => {
      const customKeyTracer = new TracerService(
        registry,
        als as never,
        {} as ObserveAgentSharedBuffer,
        { traceIdKey: "requestId" } as ObserveModuleOptionsWithDefaults,
      );
      await inTrace("custom-key", async (spanId) => {
        await als.run(new Map([["requestId", "custom-key"]]), async () => {
          await Promise.resolve();
          customKeyTracer.setOperationId("/rpc/orders.list");
        });
        registry.internalEndTraceStep(
          "custom-key",
          spanId,
          "OrdersController",
          "findAll",
          spanId,
        );
      });
      registry.endTrace("custom-key");

      expect(await registry.pluckSnapshot("custom-key")).toMatchObject({
        operationId: "/rpc/orders.list",
      });
    });

    it("prefers the internal registry key over the reported trace id", async () => {
      await inTrace("reported", async (reportedSpan) => {
        await inTrace("internal", (internalSpan) => {
          als.getStore()!.set(TRACE_REGISTRY_KEY, "internal");
          als.getStore()!.set(TRACE_ID_KEY, "reported");
          tracer.setOperationId("/rpc/orders.list");
          registry.internalEndTraceStep(
            "internal",
            internalSpan,
            "OrdersController",
            "findAll",
            internalSpan,
          );
        });
        registry.internalEndTraceStep(
          "reported",
          reportedSpan,
          "OrdersController",
          "findAll",
          reportedSpan,
        );
      });
      registry.endTrace("internal");
      registry.endTrace("reported");

      expect(await registry.pluckSnapshot("internal")).toMatchObject({
        operationId: "/rpc/orders.list",
      });
      expect(await registry.pluckSnapshot("reported")).toMatchObject({
        operationId: "GET /orders",
      });
    });

    it("is a no-op outside any async context", () => {
      const setOperationId = vi.spyOn(registry, "setOperationId");

      expect(() => tracer.setOperationId("/rpc/orders.list")).not.toThrow();
      expect(setOperationId).not.toHaveBeenCalled();
    });

    it.each([undefined, 42])(
      "is a no-op when the trace id is %s",
      (traceId) => {
        const setOperationId = vi.spyOn(registry, "setOperationId");

        als.run(new Map([[TRACE_ID_KEY, traceId]]), () => {
          expect(() => tracer.setOperationId("/rpc/orders.list")).not.toThrow();
        });
        expect(setOperationId).not.toHaveBeenCalled();
      },
    );

    it("is a no-op for an unsampled request", () => {
      als.run(new Map([[TRACE_ID_KEY, "unsampled"]]), () => {
        expect(() => tracer.setOperationId("/rpc/orders.list")).not.toThrow();
      });

      expect(registry.hasTrace("unsampled")).toBe(false);
    });

    /** The operation id `name` leaves on a request named "GET /orders". */
    const reportedAfter = async (name: unknown) => {
      await inTrace("named", (spanId) => {
        tracer.setOperationId(name as string);
        registry.internalEndTraceStep(
          "named",
          spanId,
          "OrdersController",
          "findAll",
          spanId,
        );
      });
      registry.endTrace("named");
      const snapshot = await registry.pluckSnapshot("named");
      return (snapshot as RequestSnapshot).operationId;
    };

    it("trims the name", async () => {
      expect(await reportedAfter("  /rpc/orders.list\n")).toBe(
        "/rpc/orders.list",
      );
    });

    it("cuts a long name to 255 characters, counted as the collector counts them", async () => {
      const reported = await reportedAfter(`/rpc/${"😀".repeat(300)}`);

      expect(Array.from(reported!)).toHaveLength(255);
      // Cut between characters, never inside a surrogate pair.
      expect(reported!.endsWith("😀")).toBe(true);
    });

    describe("given something other than a non-blank string", () => {
      let warn: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      });

      afterEach(() => {
        warn.mockRestore();
      });

      // Typed as a string, but often read off a request body: a number would
      // have the collector refuse the batch, a blank name would drop the
      // request.
      it.each([
        ["an empty string", ""],
        ["a blank string", "  "],
        ["a number", 42],
        ["an object", { method: "orders.list" }],
        ["null", null],
        ["undefined", undefined],
      ])("ignores %s and keeps the route", async (_, name) => {
        expect(await reportedAfter(name)).toBe("GET /orders");
      });

      it("says so once, not on every request", () => {
        als.run(new Map([[TRACE_ID_KEY, "named"]]), () => {
          tracer.setOperationId(42 as never);
          tracer.setOperationId("");
        });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "setOperationId ignored a value of type number",
          ),
        );
      });
    });
  });

  describe("activeSpan", () => {
    it("returns a delegate for the span in scope", async () => {
      const span = await inTrace("a1", () => tracer.activeSpan());

      expect(span).toBeDefined();
      expect(() => span.addTags({ any: "thing" })).not.toThrow();
    });

    it("writes tags through onto the real span", async () => {
      await inTrace("a2", async (spanId) => {
        const span = await tracer.activeSpan();
        span.addTags({ tenant: "acme" });
        registry.internalEndTraceStep("a2", spanId, "C", "m", spanId);
      });
      registry.endTrace("a2");

      const snapshot = await registry.pluckSnapshot("a2");
      // The delegate holds a reference to the span's own tag object; a copy
      // would silently discard everything the caller set.
      expect((snapshot!.traces[0] as { tags?: unknown }).tags).toMatchObject({
        tenant: "acme",
      });
    });

    it("fails clearly when the trace is open but no span is active", async () => {
      registry.startTrace("a3", {
        operationId: "GET /orders",
        protocol: "http",
        attributes: { method: "GET", originalUrl: "/orders" },
        tags: {},
      });

      await expect(
        als.run(new Map([[TRACE_ID_KEY, "a3"]]), () => tracer.activeSpan()),
      ).rejects.toThrow(/No active span found/);
    });

    it("hands back a detached delegate when the operation is not recorded", async () => {
      // An ignored or sampled-out operation: the id is in the store for log
      // correlation, but no trace was ever opened under it.
      const span = await als.run(new Map([[TRACE_ID_KEY, "unrecorded"]]), () =>
        tracer.activeSpan(),
      );

      expect(() => span.setTag("tenant", "acme")).not.toThrow();
      expect(registry.hasTrace("unrecorded")).toBe(false);
    });

    it("fails clearly outside any async context", async () => {
      await expect(tracer.activeSpan()).rejects.toThrow(
        /AsyncLocalStorage is not initialized/,
      );
    });
  });

  describe("captureError", () => {
    it("attaches the error and tags to the active span", async () => {
      await inTrace("c1", async (spanId) => {
        await tracer.captureError(new Error("captured"), { orderId: "o-2" });
        registry.internalEndTraceStep("c1", spanId, "C", "m", spanId);
      });
      registry.endTrace("c1");

      const snapshot = await registry.pluckSnapshot("c1");
      const root = snapshot!.traces[0] as {
        error?: { message: string };
        tags?: Record<string, unknown>;
      };
      expect(root.error).toMatchObject({ message: "captured" });
      expect(root.tags).toMatchObject({ orderId: "o-2" });
    });

    it("hands nothing to the registry when the agent is disabled", async () => {
      // A disabled agent opens no trace for the request, and the registry
      // warns about every error it is given without one.
      const disabled = new TracerService(
        registry,
        als as never,
        {} as ObserveAgentSharedBuffer,
        {
          traceIdKey: TRACE_ID_KEY,
          enabled: false,
        } as ObserveModuleOptionsWithDefaults,
      );
      const captureError = vi.spyOn(registry, "captureError");

      await als.run(new Map([[TRACE_ID_KEY, "untraced"]]), () =>
        disabled.captureError(new Error("x")),
      );

      expect(captureError).not.toHaveBeenCalled();
    });

    it("fails clearly outside any async context", async () => {
      await expect(tracer.captureError(new Error("x"))).rejects.toThrow(
        /AsyncLocalStorage is not initialized/,
      );
    });
  });

  describe("metric registry", () => {
    it("returns the same counter for the same name", () => {
      const first = tracer.counter("orders");
      first.increment(5);

      const second = tracer.counter("orders");

      // Two instances would each hold their own total and the reported figure
      // would be whichever flushed last.
      expect(second).toBe(first);
      expect(second.getValue()).toBe(5);
    });

    it("returns the same gauge for the same name", () => {
      const first = tracer.gauge("in_flight");
      first.increment(3);

      expect(tracer.gauge("in_flight")).toBe(first);
      expect(tracer.gauge("in_flight").getValue()).toBe(3);
    });

    it("returns the same summary for the same name", () => {
      const first = tracer.summary("latency");
      first.observe(10);

      expect(tracer.summary("latency")).toBe(first);
      expect(tracer.summary("latency").observations.default).toBe(1);
    });

    it("keeps metrics of different names apart", () => {
      tracer.counter("a").increment(1);
      tracer.counter("b").increment(2);

      expect(tracer.counter("a").getValue()).toBe(1);
      expect(tracer.counter("b").getValue()).toBe(2);
    });

    it("does not confuse a counter with a gauge of the same name", () => {
      const counter = tracer.counter("shared_name");
      const gauge = tracer.gauge("shared_name");

      // Separate registries per type: they encode differently and merge
      // differently on the backend.
      expect(gauge).not.toBe(counter);
      expect(counter.type).toBe("counter");
      expect(gauge.type).toBe("gauge");
    });

    it("updates the description of an existing metric", () => {
      tracer.counter("orders");

      const updated = tracer.counter("orders", {
        description: "Orders placed",
      });

      // A later call site adding documentation should not be ignored, nor
      // should it reset the running total.
      expect(updated.description).toBe("Orders placed");
    });

    it("applies an initial value only while the metric is still at zero", () => {
      const counter = tracer.counter("visits");
      counter.increment(7);

      const reused = tracer.counter("visits", { initialValue: 100 });

      // Retroactively seeding a counter that has already counted would discard
      // real measurements.
      expect(reused.getValue()).toBe(7);
    });

    it("updates a gauge's kind on a later call", () => {
      tracer.gauge("cpu");

      expect(tracer.gauge("cpu", { kind: "peak" }).kind).toBe("peak");
    });
  });

  describe("buffering", () => {
    it("pushes a counter to the buffer when it changes", () => {
      tracer.counter("orders").increment();

      // The flush loop reads the buffer; a metric that never announced itself
      // is a metric that never leaves the process.
      expect(upserted.map((metric) => metric.name)).toContain("orders");
    });

    it("pushes a gauge to the buffer when it changes", () => {
      tracer.gauge("in_flight").increment();
      tracer.gauge("in_flight").decrement();
      tracer.gauge("in_flight").setValue(4);

      expect(
        upserted.filter((metric) => metric.name === "in_flight"),
      ).toHaveLength(3);
    });

    it("pushes a summary to the buffer when it observes", () => {
      tracer.summary("latency").observe(12);

      expect(upserted.map((metric) => metric.name)).toContain("latency");
    });

    it("does not push on mere retrieval", () => {
      tracer.counter("quiet");
      tracer.counter("quiet");

      // Registering a metric is not an event; only a change is.
      expect(upserted).toEqual([]);
    });

    it("keeps pushing after a metric is re-retrieved", () => {
      tracer.counter("orders").increment();
      tracer.counter("orders").increment();

      // The change handler is attached once at creation; re-fetching must not
      // return an instance whose handler was lost.
      expect(
        upserted.filter((metric) => metric.name === "orders"),
      ).toHaveLength(2);
    });
  });
});
