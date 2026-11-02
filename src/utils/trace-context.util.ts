import { createHash, randomBytes } from "crypto";
import {
  activeOpenTelemetrySpanContext,
  OpenTelemetrySpanContext,
} from "./opentelemetry.util.js";

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/): the `traceparent`
 * and `tracestate` headers every OpenTelemetry SDK, most proxies and meshes,
 * and the major clouds' load balancers read and write.
 *
 * Observe's own propagation is `x-request-id`, which only another service
 * running this agent understands. Speaking `traceparent` as well is what
 * lets a call through a Go, Python or Java service - or an OpenTelemetry
 * backend reading what `otlp` exports - stay one trace.
 */
export interface TraceContext {
  /** 32 lowercase hex digits, never all zeros. */
  traceId: string;
  /**
   * The caller's span, 16 lowercase hex digits: the parent of the span this
   * process opens for the operation.
   */
  parentSpanId: string;
  /** The caller's `sampled` flag: whether it may be recording the trace. */
  sampled: boolean;
  /**
   * `tracestate`, as received with it. Vendors keep their own entries there,
   * and the spec asks every hop to pass the list on.
   */
  traceState?: string;
}

/**
 * `version-traceid-parentid-flags`, as the spec defines it: lowercase hex
 * only, a trace id and a parent id that are not all zeros, and any version
 * but the reserved `ff`. Version 00 ends after the flags; a later version may
 * carry more after another dash, which is read past rather than refused, so
 * a caller on a newer revision of the spec is still followed.
 */
const TRACEPARENT_PATTERN =
  /^[ \t]*((?!ff)[0-9a-f]{2})-((?![0]{32})[0-9a-f]{32})-((?![0]{16})[0-9a-f]{16})-([0-9a-f]{2})(-[^ \t]*)?[ \t]*$/;

/**
 * The longest `tracestate` passed on. The spec asks every vendor to carry at
 * least 512 characters of it and lets a longer one lose entries from its
 * end; a header is not the place for an unbounded value either way.
 */
const MAX_TRACE_STATE_LENGTH = 512;

/** Printable ASCII: no control characters, nothing a header cannot carry. */
const TRACE_STATE_PATTERN = /^[\x20-\x7e]+$/;

/** What a span context's ids must be: lowercase hex, never all zeros. */
const SPAN_CONTEXT_TRACE_ID_PATTERN = /^(?![0]{32})[0-9a-f]{32}$/;
const SPAN_CONTEXT_SPAN_ID_PATTERN = /^(?![0]{16})[0-9a-f]{16}$/;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

/**
 * The trace context a request arrived with, or `undefined` when it carried
 * no `traceparent` the spec would accept.
 *
 * Headers are client-supplied, so anything malformed is ignored rather than
 * repaired - an array (a repeated header), the wrong case, a zero id. The
 * spec's answer to an invalid `traceparent` is to start a new trace, and its
 * `tracestate` goes with it.
 */
export function readTraceContext(
  headers: Record<string, unknown> | undefined,
): TraceContext | undefined {
  const traceparent = headers?.["traceparent"];
  if (typeof traceparent !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) {
    return undefined;
  }
  const [, version, traceId, parentSpanId, flags, rest] = match;
  // Version 00 has exactly four fields, so anything after them means the
  // header is not what it claims to be - two headers folded into one, say.
  if (version === "00" && rest !== undefined) {
    return undefined;
  }
  const context: TraceContext = {
    traceId,
    parentSpanId,
    sampled: (parseInt(flags, 16) & 0x01) === 0x01,
  };
  const traceState = fitTraceState(headers?.["tracestate"]);
  if (traceState) {
    context.traceState = traceState;
  }
  return context;
}

/**
 * The received `tracestate`, held to what is safe to send on: printable,
 * and at most `MAX_TRACE_STATE_LENGTH` characters - a longer one loses
 * whole entries from its end, which the spec allows, never half of one.
 * Node joins a repeated header with ", ", which is the list the spec means.
 */
function fitTraceState(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || !TRACE_STATE_PATTERN.test(trimmed)) {
    return undefined;
  }
  if (trimmed.length <= MAX_TRACE_STATE_LENGTH) {
    return trimmed;
  }
  let fitted = "";
  for (const entry of trimmed.split(",")) {
    const member = entry.trim();
    if (!member) {
      continue;
    }
    const next = fitted ? `${fitted},${member}` : member;
    if (next.length > MAX_TRACE_STATE_LENGTH) {
      break;
    }
    fitted = next;
  }
  return fitted || undefined;
}

/**
 * The trace id a `traceparent` header carries, written as a UUID - the
 * shape of every id this agent mints - or `undefined` when it carries none
 * the spec would accept.
 *
 * Written that way rather than as 32 bare digits so the id reads the same
 * in the dashboard, in logs and in `currentTraceId()` whichever side minted
 * it, and so `w3cTraceIdOf` turns it back into exactly the trace id the
 * caller sent.
 */
export function traceIdFromTraceparent(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  const traceId = readTraceContext(headers)?.traceId;
  return traceId === undefined ? undefined : toUuid(traceId);
}

/**
 * The W3C trace context an operation runs in: the span an OpenTelemetry SDK
 * in this process opened for it, when one runs, else the `traceparent` it
 * arrived with.
 *
 * The SDK's span first, because the SDK has already decided the trace: it
 * continued the caller's, through whichever propagator it was given, or
 * started one when there was nothing to continue. Taking that decision is
 * what makes a service running both report one trace id to both, the
 * service at the root of a trace included.
 */
export function inboundTraceContext(
  headers: Record<string, unknown> | undefined,
): TraceContext | undefined {
  return (
    traceContextOfSpan(activeOpenTelemetrySpanContext()) ??
    readTraceContext(headers)
  );
}

/**
 * `inboundTraceContext`'s trace id, written as a UUID - as
 * `traceIdFromTraceparent` writes it.
 */
export function inboundTraceId(
  headers: Record<string, unknown> | undefined,
): string | undefined {
  const traceId = inboundTraceContext(headers)?.traceId;
  return traceId === undefined ? undefined : toUuid(traceId);
}

/**
 * An OpenTelemetry span context as the trace context an operation runs in,
 * the span becoming the operation's parent - or `undefined` for one the spec
 * would not accept, such as the all-zero context of a span never started.
 */
function traceContextOfSpan(
  spanContext: OpenTelemetrySpanContext | undefined,
): TraceContext | undefined {
  if (
    !spanContext ||
    typeof spanContext.traceId !== "string" ||
    typeof spanContext.spanId !== "string" ||
    !SPAN_CONTEXT_TRACE_ID_PATTERN.test(spanContext.traceId) ||
    !SPAN_CONTEXT_SPAN_ID_PATTERN.test(spanContext.spanId)
  ) {
    return undefined;
  }
  const context: TraceContext = {
    traceId: spanContext.traceId,
    parentSpanId: spanContext.spanId,
    sampled: (spanContext.traceFlags & 0x01) === 0x01,
  };
  let traceState: string | undefined;
  try {
    traceState = fitTraceState(spanContext.traceState?.serialize());
  } catch {
    // A trace state that cannot be written out is no trace state.
  }
  if (traceState) {
    context.traceState = traceState;
  }
  return context;
}

/**
 * The W3C trace id an Observe trace id goes out under.
 *
 * Every id the agent mints is a UUID, which is a 128-bit W3C trace id with
 * dashes in it, so those - and any 32-digit hex id - map onto one by
 * dropping the dashes. An adopted `x-request-id` can be anything at all
 * (`req_8f2c`), and becomes the first 128 bits of its SHA-256 instead: the
 * same id always gives the same trace id, so every hop that derives it -
 * this process's outbound calls, another service running this agent, the
 * spans `otlp` exports - lands in one trace.
 */
export function w3cTraceIdOf(traceId: string): string {
  let hex: string | undefined;
  if (UUID_PATTERN.test(traceId)) {
    hex = traceId.replace(/-/g, "").toLowerCase();
  } else if (HEX_TRACE_ID_PATTERN.test(traceId)) {
    hex = traceId.toLowerCase();
  }
  // All zeros is the one value the spec forbids - the nil UUID, sent as an
  // `x-request-id` - so it is hashed like any other id that does not fit.
  if (hex === undefined || hex === ZERO_TRACE_ID) {
    hex = createHash("sha256").update(traceId).digest("hex").slice(0, 32);
  }
  return hex;
}

/**
 * The W3C span id an Observe span id goes out under: the low 64 bits of its
 * UUID.
 *
 * The low half rather than the high one because in a UUIDv7 the high half
 * is mostly the mint time, which every span opened in the same millisecond
 * shares; the low half is 62 random bits under the variant, which also keeps
 * it from ever being all zeros. Anything that is not a UUID is hashed, as
 * `w3cTraceIdOf` does.
 */
export function w3cSpanIdOf(spanId: string): string {
  if (UUID_PATTERN.test(spanId)) {
    const low = spanId.replace(/-/g, "").slice(16).toLowerCase();
    if (low !== ZERO_SPAN_ID) {
      return low;
    }
  }
  return createHash("sha256").update(spanId).digest("hex").slice(0, 16);
}

/** A fresh W3C span id, for a span that has no Observe id to derive one from. */
export function randomSpanId(): string {
  for (;;) {
    const id = randomBytes(8).toString("hex");
    if (id !== ZERO_SPAN_ID) {
      return id;
    }
  }
}

/** A version-00 `traceparent`. Only the `sampled` flag is ever set. */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  sampled: boolean,
): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

function toUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
