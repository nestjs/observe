import {
  CALLER_METADATA_KEY,
  TRACE_CONTEXT_KEY,
} from "../observe.constants.js";
import {
  activeOpenTelemetrySpanContext,
  withRemoteOpenTelemetryParent,
} from "./opentelemetry.util.js";
import {
  formatTraceparent,
  randomSpanId,
  readTraceContext,
  TraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "./trace-context.util.js";

/**
 * W3C Trace Context for work an operation hands on where no OpenTelemetry
 * instrumentation carries it - a queue job it enqueues, a microservice
 * message it sends - with `openTelemetry` on.
 *
 * Observe carries its own trace id across those hops already: in a job's
 * options (`observeTraceId`) and in a message's `x-request-id` metadata. An
 * OpenTelemetry SDK in the process that runs the job or handles the message
 * has nothing to go on, though, so the spans it opens there - and the
 * `traceparent` on every call they make - would start a trace of their own,
 * which every service further down then follows. So the hop carries a
 * `traceparent` too, and the other side hands it to the SDK.
 */

/** A span id the spec accepts: 16 lowercase hex digits, not all zeros. */
const SPAN_ID_PATTERN = /^(?![0]{16})[0-9a-f]{16}$/;

/**
 * The `traceparent` an operation hands on with work it starts elsewhere,
 * beside the Observe trace id `traceId` that the work inherits.
 *
 * Its trace is the W3C form of `traceId`, so the work has one trace id in
 * both tools whatever side runs it. Its parent is the span an OpenTelemetry
 * SDK in this process has open, when that span is in the same trace - so
 * the SDK's spans for the work nest under the request's in its backend -
 * and its sampled flag is that span's. Otherwise it is the span Observe has
 * open, as on an outbound HTTP call, with the sampled flag the operation
 * arrived with, else whether Observe is recording it.
 *
 * `store` is the operation's async store.
 */
export function traceparentToHandOn(
  store: ReadonlyMap<unknown, unknown> | undefined,
  traceId: string,
): string {
  const w3cTraceId = w3cTraceIdOf(traceId);
  const active = activeOpenTelemetrySpanContext();
  if (
    active?.traceId === w3cTraceId &&
    typeof active.spanId === "string" &&
    SPAN_ID_PATTERN.test(active.spanId)
  ) {
    return formatTraceparent(
      w3cTraceId,
      active.spanId,
      (active.traceFlags & 0x01) === 0x01,
    );
  }
  const caller = store?.get(CALLER_METADATA_KEY);
  const received = store?.get(TRACE_CONTEXT_KEY) as TraceContext | undefined;
  const recorded = typeof caller === "string";
  return formatTraceparent(
    w3cTraceId,
    recorded ? w3cSpanIdOf(caller) : randomSpanId(),
    received?.traceId === w3cTraceId ? received.sampled : recorded,
  );
}

/**
 * Runs `run` in the trace a `traceparent` handed on with the work names -
 * see `traceparentToHandOn` - for an OpenTelemetry SDK in this process: the
 * spans it opens inside `run` join that trace, under the span that handed
 * the work on, and the calls they cover carry the trace on.
 *
 * Only a `traceparent` the spec accepts, and only in the trace `traceId` -
 * the Observe trace id the work runs under - maps onto: job options and
 * packet metadata are writable by anything that reaches Redis or the
 * socket, and a span from another trace would put the work under one it
 * never ran beside. Anything else runs `run` as it is.
 *
 * So does work an OpenTelemetry instrumentation has already taken up, with
 * a span of that trace open for it - BullMQ's `bullmq-otel` opens one for
 * each job, and OpenTelemetry's Kafka and RabbitMQ instrumentations one for
 * each message they deliver. The work's spans belong under that span, which
 * the handed-on parent would put them beside.
 */
export function continueHandedOnTrace<T>(
  traceparent: unknown,
  traceId: string,
  run: () => T,
): T {
  const parent =
    typeof traceparent === "string"
      ? readTraceContext({ traceparent })
      : undefined;
  if (
    !parent ||
    parent.traceId !== w3cTraceIdOf(traceId) ||
    activeOpenTelemetrySpanContext()?.traceId === parent.traceId
  ) {
    return run();
  }
  return withRemoteOpenTelemetryParent(
    {
      traceId: parent.traceId,
      spanId: parent.parentSpanId,
      sampled: parent.sampled,
    },
    run,
  );
}

/**
 * Whether OpenTelemetry interop runs now - `openTelemetry` on, beside
 * reporting to NestJS Observe (see `ObserveAgentSharedBuffer.isReporting`) -
 * for what is set up before the module's options resolve: the microservice
 * dispatch hook, which a client is handed as it is instantiated. Off until
 * the module configures it.
 */
export class OpenTelemetryInteropGate {
  private options?: { openTelemetry?: boolean };
  private buffer?: { isReporting(): boolean };

  configure(
    options: { openTelemetry?: boolean } | undefined,
    buffer: { isReporting(): boolean } | undefined,
  ): this {
    this.options = options;
    this.buffer = buffer;
    return this;
  }

  isOn(): boolean {
    return (
      this.options?.openTelemetry === true &&
      this.buffer?.isReporting() === true
    );
  }
}
