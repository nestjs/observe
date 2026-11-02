import { loadOptionalPeer } from "./optional-peer.util.js";

/**
 * A span's identity as `@opentelemetry/api` hands it out - the slice of
 * `SpanContext` the agent reads.
 */
export interface OpenTelemetrySpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  traceState?: { serialize(): string };
}

/**
 * The slice of `@opentelemetry/api` the agent reads: enough to tell which span
 * an OpenTelemetry SDK running in this process has open, and whether it writes
 * `traceparent` on the calls it instruments.
 */
interface OpenTelemetryApi {
  trace: {
    getActiveSpan(): { spanContext(): OpenTelemetrySpanContext } | undefined;
  };
  propagation: { fields(): string[] };
}

/** `undefined` until first asked for, `null` when the package is absent. */
let api: OpenTelemetryApi | null | undefined;

/**
 * `@opentelemetry/api`, as the application installed it, or `null`.
 *
 * Any copy will do: every copy of the package keeps its state on one global,
 * so the one resolved from here sees the SDK the application registered
 * through its own. With the package installed and no SDK registered, it
 * answers as a no-op - no active span, no propagated fields - which is the
 * agent's own behaviour anyway.
 */
function openTelemetryApi(): OpenTelemetryApi | null {
  if (api === undefined) {
    const loaded = loadOptionalPeer<OpenTelemetryApi>("@opentelemetry/api");
    api = (loaded.installed && loaded.module) || null;
  }
  return api;
}

/**
 * The span an OpenTelemetry SDK in this process has open in the current
 * context - for an incoming request, the server span its HTTP instrumentation
 * opened - or `undefined` when none runs.
 *
 * Read so that a service running both reports to Observe under the trace id
 * the SDK gave the request, including when the request started the trace.
 * Never throws: an SDK this cannot read is treated as absent.
 */
export function activeOpenTelemetrySpanContext():
  | OpenTelemetrySpanContext
  | undefined {
  try {
    return openTelemetryApi()?.trace.getActiveSpan()?.spanContext();
  } catch {
    return undefined;
  }
}

/**
 * Whether an OpenTelemetry SDK in this process propagates W3C Trace Context,
 * and so writes `traceparent` on the outbound calls it instruments.
 *
 * The agent then leaves the header to it, whichever of the two sees a call
 * first: two `traceparent` headers on one request are not a valid one, and
 * the SDK's names the span the rest of its trace nests under.
 */
export function openTelemetryWritesTraceparent(): boolean {
  try {
    return (
      openTelemetryApi()?.propagation.fields().includes("traceparent") ?? false
    );
  } catch {
    return false;
  }
}
