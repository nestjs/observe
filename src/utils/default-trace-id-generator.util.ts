import { inboundTraceId, w3cTraceIdOf } from "./trace-context.util.js";
import { uuidv7 } from "./uuid-v7.util.js";

/**
 * What an inbound `x-request-id` must look like to be adopted as the trace id.
 *
 * The header is client-supplied, so it is honoured only when it is a single,
 * short, unambiguous token. Anything else - an array (Node folds repeated
 * headers into one), an oversized value, control characters, exotic symbols -
 * falls back to a random id: the header exists to let a proxy correlate its
 * own logs with a trace, not to let an arbitrary caller choose what gets
 * written into the telemetry store, collide with an existing trace, or inflate
 * a row with an unbounded value.
 */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function defaultTraceIdGenerator(req: unknown) {
  if (typeof req === "object" && req !== null && "headers" in req) {
    const requestId = (req as { headers: Record<string, unknown> }).headers[
      "x-request-id"
    ];
    if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) {
      return requestId;
    }
  }
  // A microservice context, on a transport whose packets carry metadata: the
  // id the calling service's client attached. Held to the same shape as the
  // header - a packet is no more trustworthy than a request.
  const getMetadata = (req as { getMetadata?: unknown } | null)?.getMetadata;
  if (typeof getMetadata === "function") {
    const metadata: unknown = getMetadata.call(req);
    const requestId = (metadata as Record<string, unknown> | undefined)?.[
      "x-request-id"
    ];
    if (typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)) {
      return requestId;
    }
  }
  // Minted here, so it can carry its time - see uuidv7.
  return uuidv7();
}

/**
 * The default `traceIdGenerator` with `openTelemetry` on.
 *
 * A request in a W3C trace is named after that trace, so it has the id the
 * rest of the trace has in the caller's OpenTelemetry backend: the trace a
 * caller's `traceparent` names - a service in another language, a mesh, a
 * load balancer that starts traces - or, when an OpenTelemetry SDK runs in
 * this process, the one it continued or started for the request (see
 * `inboundTraceContext`). Anything else is named as `defaultTraceIdGenerator`
 * names it.
 *
 * An `x-request-id` beside the trace names some other one when a mesh or a
 * router stamped it (Envoy and Heroku's router stamp every request), and gives
 * way. It stays only when it names this same trace: another service running
 * this agent sends both, and its id may be one `traceparent` cannot carry - a
 * custom id, or a UUIDv7 whose mint time the collector reads.
 */
export function openTelemetryTraceIdGenerator(req: unknown) {
  if (typeof req === "object" && req !== null && "headers" in req) {
    const headers = (req as { headers: Record<string, unknown> }).headers;
    const fromTraceContext = inboundTraceId(headers);
    if (fromTraceContext) {
      const requestId = headers?.["x-request-id"];
      return typeof requestId === "string" &&
        REQUEST_ID_PATTERN.test(requestId) &&
        w3cTraceIdOf(requestId) === w3cTraceIdOf(fromTraceContext)
        ? requestId
        : fromTraceContext;
    }
  }
  return defaultTraceIdGenerator(req);
}
