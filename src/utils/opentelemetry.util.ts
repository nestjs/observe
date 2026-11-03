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
 * The slice of `@opentelemetry/api` the agent uses: enough to tell which span
 * an OpenTelemetry SDK running in this process has open, whether it writes
 * `traceparent` on the calls it instruments, and to hand it a remote parent
 * to continue.
 */
interface OpenTelemetryApi {
  trace: {
    getActiveSpan(): { spanContext(): OpenTelemetrySpanContext } | undefined;
    setSpanContext(
      context: unknown,
      spanContext: OpenTelemetrySpanContext & { isRemote: boolean },
    ): unknown;
  };
  context: {
    active(): unknown;
    with<T>(context: unknown, fn: () => T): T;
  };
  propagation: { fields(): string[] };
}

/**
 * A span in another process, or in the operation that handed this work on,
 * for an OpenTelemetry SDK here to continue - what its propagator reads off
 * a `traceparent`.
 */
export interface RemoteParent {
  /** 32 lowercase hex digits. */
  traceId: string;
  /** 16 lowercase hex digits. */
  spanId: string;
  sampled: boolean;
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

/**
 * Runs `run` with `parent` as the span an OpenTelemetry SDK in this process
 * continues, as its propagator continues a `traceparent` read off an
 * incoming request: the spans its instrumentations open inside `run` join
 * `parent`'s trace, under it, and the calls they cover carry that trace on.
 *
 * For work that reaches this process by a way no OpenTelemetry
 * instrumentation covers - a queue job, a microservice message - and that
 * would otherwise run in no trace at all. Without `@opentelemetry/api`, or
 * with no SDK registered on it, `run` just runs. Never the reason `run`
 * fails: an API this cannot use is treated as absent, and what `run` itself
 * throws is thrown as it is.
 */
export function withRemoteOpenTelemetryParent<T>(
  parent: RemoteParent,
  run: () => T,
): T {
  let enter: ((fn: () => T) => T) | undefined;
  try {
    const otel = openTelemetryApi();
    if (otel) {
      const parentContext = otel.trace.setSpanContext(otel.context.active(), {
        traceId: parent.traceId,
        spanId: parent.spanId,
        traceFlags: parent.sampled ? 0x01 : 0x00,
        isRemote: true,
      });
      enter = (fn) => otel.context.with(parentContext, fn);
    }
  } catch {
    enter = undefined;
  }
  if (!enter) {
    return run();
  }
  let entered = false;
  try {
    return enter(() => {
      entered = true;
      return run();
    });
  } catch (error) {
    if (entered) {
      throw error;
    }
    // The SDK's context manager failed before `run` started.
    return run();
  }
}
