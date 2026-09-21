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
