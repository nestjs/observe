import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { defaultTraceIdGenerator } from "./default-trace-id-generator.util.js";
import {
  activeOpenTelemetrySpanContext,
  openTelemetryWritesTraceparent,
} from "./opentelemetry.util.js";
import { inboundTraceContext } from "./trace-context.util.js";

const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("OpenTelemetry in the same process", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  describe("with no SDK registered", () => {
    it("finds no span, and leaves traceparent to the agent", () => {
      // @opentelemetry/api is installed here, as it is in most applications
      // that depend on a library using it - which is not an SDK running.
      expect(activeOpenTelemetrySpanContext()).toBeUndefined();
      expect(openTelemetryWritesTraceparent()).toBe(false);
    });

    it("reads the request's own traceparent", () => {
      expect(inboundTraceContext({ traceparent: TRACEPARENT })).toEqual({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        parentSpanId: "00f067aa0ba902b7",
        sampled: true,
      });
    });
  });

  describe("with an SDK registered", () => {
    beforeEach(() => {
      context.setGlobalContextManager(
        new AsyncLocalStorageContextManager().enable(),
      );
      trace.setGlobalTracerProvider(new BasicTracerProvider());
      propagation.setGlobalPropagator(
        new CompositePropagator({
          propagators: [
            new W3CTraceContextPropagator(),
            new W3CBaggagePropagator(),
          ],
        }),
      );
    });

    it("takes the trace of the span the SDK has open, over the request's traceparent", () => {
      // The SDK's server span has already continued the caller's trace, or
      // started one: its span is the parent of what the agent records.
      trace.getTracer("test").startActiveSpan("GET /orders", (span) => {
        const { traceId, spanId } = span.spanContext();

        expect(inboundTraceContext({ traceparent: TRACEPARENT })).toEqual({
          traceId,
          parentSpanId: spanId,
          sampled: true,
        });
        span.end();
      });
    });

    it("names the request by the SDK's trace when it started the trace", () => {
      trace.getTracer("test").startActiveSpan("GET /orders", (span) => {
        const { traceId } = span.spanContext();
        const expected = `${traceId.slice(0, 8)}-${traceId.slice(8, 12)}-${traceId.slice(12, 16)}-${traceId.slice(16, 20)}-${traceId.slice(20)}`;

        expect(defaultTraceIdGenerator({ headers: {} })).toBe(expected);
        // A mesh's request id names no trace the SDK knows, and gives way.
        expect(
          defaultTraceIdGenerator({
            headers: { "x-request-id": "6f1a52c4-3d0b-4e8a-9c2f-7b1d0e9a8c34" },
          }),
        ).toBe(expected);
        span.end();
      });
    });

    it("keeps the SDK's tracestate and sampling decision", () => {
      // What the SDK's propagator made of an unsampled caller's headers.
      const extracted = propagation.extract(context.active(), {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
        tracestate: "vendor=abc",
      });
      context.with(extracted, () => {
        expect(inboundTraceContext({})).toEqual({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "00f067aa0ba902b7",
          sampled: false,
          traceState: "vendor=abc",
        });
      });
    });

    it("ignores a span that never started, and falls back to the header", () => {
      context.with(
        trace.setSpanContext(context.active(), {
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          traceFlags: 0,
        }),
        () => {
          expect(
            inboundTraceContext({ traceparent: TRACEPARENT })?.traceId,
          ).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        },
      );
    });

    it("leaves traceparent to an SDK that propagates W3C trace context", () => {
      expect(openTelemetryWritesTraceparent()).toBe(true);
    });

    it("still writes traceparent beside an SDK that propagates something else", () => {
      // B3's headers, as an SDK configured with OTEL_PROPAGATORS=b3 sends.
      propagation.disable();
      propagation.setGlobalPropagator({
        inject: () => undefined,
        extract: (ctx) => ctx,
        fields: () => ["b3"],
      });

      expect(openTelemetryWritesTraceparent()).toBe(false);
    });
  });
});
