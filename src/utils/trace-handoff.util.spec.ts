import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  CALLER_METADATA_KEY,
  TRACE_CONTEXT_KEY,
} from "../observe.constants.js";
import {
  readTraceContext,
  TraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "./trace-context.util.js";
import {
  continueHandedOnTrace,
  OpenTelemetryInteropGate,
  traceparentToHandOn,
} from "./trace-handoff.util.js";

// The W3C spec's own example, and the id Observe writes it as.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_ID_AS_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;
/** The id of a span Observe has open, as the store carries it. */
const OBSERVE_SPAN_ID = "019a4b1c-2d3e-7f40-8a51-b6c7d8e9f001";

const storeOf = (entries: Array<[unknown, unknown]> = []) =>
  new Map<unknown, unknown>(entries);

/** What `traceparent` says, read back the way the receiving side reads it. */
const parse = (traceparent: string) => readTraceContext({ traceparent });

/**
 * A queue job or a microservice message carries W3C trace context beside the
 * Observe trace id, so an OpenTelemetry SDK in the process that runs it
 * continues the trace that handed it on - see trace-handoff.util.ts.
 */
describe("W3C trace context handed on to a job or a message", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  describe("with no SDK registered", () => {
    it("names the span Observe has open, in the W3C form of the trace id", () => {
      const traceparent = traceparentToHandOn(
        storeOf([[CALLER_METADATA_KEY, OBSERVE_SPAN_ID]]),
        TRACE_ID_AS_UUID,
      );

      expect(traceparent).toBe(
        `00-${TRACE_ID}-${w3cSpanIdOf(OBSERVE_SPAN_ID)}-01`,
      );
    });

    it("passes on the sampled flag the operation arrived with", () => {
      const received: TraceContext = {
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        sampled: false,
      };

      const traceparent = traceparentToHandOn(
        storeOf([
          [CALLER_METADATA_KEY, OBSERVE_SPAN_ID],
          [TRACE_CONTEXT_KEY, received],
        ]),
        TRACE_ID_AS_UUID,
      );

      expect(parse(traceparent)?.sampled).toBe(false);
    });

    it("names a span of its own, unsampled, for an operation Observe is not recording", () => {
      const parent = parse(traceparentToHandOn(storeOf(), TRACE_ID_AS_UUID));

      expect(parent?.traceId).toBe(TRACE_ID);
      expect(parent?.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
      expect(parent?.sampled).toBe(false);
    });

    it("maps an id of the application's own onto the trace the other side derives from it", () => {
      const parent = parse(traceparentToHandOn(storeOf(), "req_8f2c"));

      expect(parent?.traceId).toBe(w3cTraceIdOf("req_8f2c"));
    });

    it("runs the work as it is", () => {
      const run = vi.fn(() => "done");

      expect(continueHandedOnTrace(TRACEPARENT, TRACE_ID_AS_UUID, run)).toBe(
        "done",
      );
      expect(run).toHaveBeenCalledOnce();
    });
  });

  describe("with an SDK registered", () => {
    const tracer = () => trace.getTracer("handoff-spec");

    beforeEach(() => {
      context.setGlobalContextManager(
        new AsyncLocalStorageContextManager().enable(),
      );
      trace.setGlobalTracerProvider(new BasicTracerProvider());
    });

    /** Runs `fn` inside a span the SDK has open in the trace `traceId`. */
    const insideSpan = <T>(
      traceId: string,
      fn: (span: ReadableSpan) => T,
      sampled = true,
    ): T => {
      const caller = trace.setSpanContext(context.active(), {
        traceId,
        spanId: SPAN_ID,
        traceFlags: sampled ? 1 : 0,
        isRemote: true,
      });
      return tracer().startActiveSpan("request", {}, caller, (span) => {
        try {
          return fn(span as unknown as ReadableSpan);
        } finally {
          span.end();
        }
      });
    };

    it("names the SDK's open span, with its sampled flag, when it is in the same trace", () => {
      insideSpan(
        TRACE_ID,
        (span) => {
          const traceparent = traceparentToHandOn(
            storeOf([[CALLER_METADATA_KEY, OBSERVE_SPAN_ID]]),
            TRACE_ID_AS_UUID,
          );

          expect(traceparent).toBe(
            `00-${TRACE_ID}-${span.spanContext().spanId}-00`,
          );
        },
        false,
      );
    });

    it("names the span Observe has open when the SDK's is in another trace", () => {
      insideSpan("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", () => {
        const traceparent = traceparentToHandOn(
          storeOf([[CALLER_METADATA_KEY, OBSERVE_SPAN_ID]]),
          TRACE_ID_AS_UUID,
        );

        expect(parse(traceparent)?.parentSpanId).toBe(
          w3cSpanIdOf(OBSERVE_SPAN_ID),
        );
      });
    });

    it("runs the work as the continuation of the span that handed it on", async () => {
      const seen = await continueHandedOnTrace(
        TRACEPARENT,
        TRACE_ID_AS_UUID,
        async () => {
          // Past an await, as a job's work goes on.
          await new Promise((resolve) => setTimeout(resolve, 1));
          const span = tracer().startSpan("call");
          span.end();
          return {
            active: trace.getSpanContext(context.active()),
            span: span as unknown as ReadableSpan,
          };
        },
      );

      expect(seen.active).toEqual({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        isRemote: true,
      });
      expect(seen.span.spanContext().traceId).toBe(TRACE_ID);
      expect(seen.span.parentSpanContext?.spanId).toBe(SPAN_ID);
      // And nothing of it outlives the work.
      expect(trace.getSpanContext(context.active())).toBeUndefined();
    });

    it("carries an unsampled decision on", () => {
      const flags = continueHandedOnTrace(
        `00-${TRACE_ID}-${SPAN_ID}-00`,
        TRACE_ID_AS_UUID,
        () => trace.getSpanContext(context.active())?.traceFlags,
      );

      expect(flags).toBe(0);
    });

    it.each([
      ["names another trace", `00-${"a".repeat(32)}-${SPAN_ID}-01`],
      ["is malformed", "not-a-traceparent"],
      ["has an all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
      ["is not a string", 42],
      ["is absent", undefined],
    ])(
      "runs the work in no trace when what was handed on %s",
      (_, traceparent) => {
        const active = continueHandedOnTrace(
          traceparent,
          TRACE_ID_AS_UUID,
          () => trace.getSpanContext(context.active()),
        );

        expect(active).toBeUndefined();
      },
    );

    it("throws what the work throws, having run it once", () => {
      const error = new Error("job failed");
      const run = vi.fn(() => {
        throw error;
      });

      expect(() =>
        continueHandedOnTrace(TRACEPARENT, TRACE_ID_AS_UUID, run),
      ).toThrow(error);
      expect(run).toHaveBeenCalledOnce();
    });
  });
});

describe("OpenTelemetryInteropGate", () => {
  const ingesting = (on: boolean) => ({ isIngesting: () => on });

  it("is off until the module configures it", () => {
    expect(new OpenTelemetryInteropGate().isOn()).toBe(false);
  });

  it("is on with openTelemetry on, beside reporting to NestJS Observe", () => {
    const gate = new OpenTelemetryInteropGate().configure(
      { openTelemetry: true },
      ingesting(true),
    );

    expect(gate.isOn()).toBe(true);
  });

  it.each([
    ["openTelemetry is off", { openTelemetry: false }, true],
    ["openTelemetry is left out", {}, true],
    ["the agent is not reporting", { openTelemetry: true }, false],
  ])("is off when %s", (_, options, reporting) => {
    const gate = new OpenTelemetryInteropGate().configure(
      options,
      ingesting(reporting),
    );

    expect(gate.isOn()).toBe(false);
  });
});
