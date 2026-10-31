import { subscribe, unsubscribe } from "diagnostics_channel";
import { LogRedactor } from "../utils/log-redactor.js";
import { openTelemetryWritesTraceparent } from "../utils/opentelemetry.util.js";
import { redactUrlQuery } from "../utils/redact-url-query.js";
import {
  formatTraceparent,
  randomSpanId,
  TraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import { attachLlmSpan } from "./llm/llm-fetch.integration.js";
import {
  OpenOutgoingSpan,
  OutgoingSpanRecorder,
} from "./outgoing-span.recorder.js";

export interface OutgoingHttpOptions {
  /**
   * Skip requests to matching URLs - no span, no trace header.
   * @example (url) => url.startsWith('https://telemetry.internal')
   */
  ignore?: (url: string) => boolean;
  /**
   * Send the current trace id as `x-request-id`, unless the request already
   * carries one. It is what a downstream service running `@nestjs/observe`
   * adopts as its own trace id, which makes HTTP-to-HTTP calls one trace with
   * no application code. A function narrows it to the URLs it returns true
   * for - your own services, say, and not third parties. It narrows
   * `traceContext` too.
   * @default true
   */
  propagateTraceId?: boolean | ((url: string) => boolean);
  /**
   * Send W3C Trace Context beside `x-request-id`: a `traceparent` naming the
   * trace and this call's span, and the `tracestate` the operation arrived
   * with, if any. It is what a service instrumented with OpenTelemetry - in
   * any language - reads, so the call stays one trace through it. The trace
   * is the one the operation's own `traceparent` named, when it arrived with
   * one. Never added to a request that already carries a `traceparent`, nor
   * while an OpenTelemetry SDK that propagates W3C Trace Context runs in the
   * same process: its instrumentations write the header on the calls they
   * cover, and a request takes only one.
   *
   * Only with `openTelemetry` on, and only while the agent is reporting to
   * NestJS Observe; otherwise no `traceparent` is sent.
   * @default true, with `openTelemetry` on
   */
  traceContext?: boolean;
}

/** What an outbound call is told about the operation making it. */
export interface OutgoingTrace {
  /** The operation's trace id, as `x-request-id` carries it. */
  traceId: string;
  /** The `traceparent` the operation arrived with, when it had one. */
  traceContext?: TraceContext;
}

const TRACE_HEADER = "x-request-id";
const TRACEPARENT_HEADER = "traceparent";
const TRACESTATE_HEADER = "tracestate";

/** `undici`'s request object, as far as the channels expose it. */
interface UndiciRequest {
  origin?: string | URL;
  path?: string;
  method?: string;
  headers?: unknown;
  addHeader?: (name: string, value: string) => unknown;
}

/** A `node:http` ClientRequest, as far as this reads it. */
interface NodeClientRequest {
  method?: string;
  protocol?: string;
  host?: string;
  path?: string;
  res?: unknown;
  getHeader?: (name: string) => unknown;
  setHeader?: (name: string, value: string) => unknown;
  once?: (event: string, listener: () => void) => unknown;
}

/**
 * Spans for outbound HTTP, from the diagnostics channels Node publishes on its
 * own: `undici` - which is also what the global `fetch` runs on - and the
 * `node:http` client that axios, got and most SDKs sit on. Nothing is patched,
 * so there is no HTTP client to keep up with.
 *
 * The handlers run synchronously inside the call that makes the request, which
 * is what puts the span under the right parent; the span is then carried to
 * the completion events on the request object itself.
 *
 * Returns the function that removes every subscription.
 */
export function subscribeOutgoingHttp(
  recorder: OutgoingSpanRecorder,
  currentTrace: () => OutgoingTrace | undefined,
  options: OutgoingHttpOptions = {},
  /**
   * Read per request rather than passed once: the redactor is configured
   * after the module's options resolve, which can be after this subscribes.
   */
  getRedactor: () => LogRedactor | null = () => null,
  /**
   * Whether calls carry W3C Trace Context now: with `openTelemetry` on and
   * `traceContext` not off, while the collector takes this app's telemetry.
   * Off unless given.
   */
  traceContextOn: () => boolean = () => false,
): () => void {
  const spans = new WeakMap<object, OpenOutgoingSpan>();
  /**
   * Span ids minted for a `node:http` request at `created`, where its
   * `traceparent` has to be written, for the span `start` opens later.
   */
  const presetSpanIds = new WeakMap<object, string>();
  const subscriptions: Array<[string, (message: unknown) => void]> = [];
  const on = <T>(channel: string, handler: (message: T) => void) => {
    const guarded = (message: unknown) => {
      // A handler that throws here throws inside the application's own
      // `fetch()` or `http.request()` call.
      try {
        handler(message as T);
      } catch {
        /* an unobserved request is the whole cost */
      }
    };
    subscribe(channel, guarded);
    subscriptions.push([channel, guarded]);
  };

  const shouldPropagate = (url: string) =>
    typeof options.propagateTraceId === "function"
      ? options.propagateTraceId(url)
      : options.propagateTraceId !== false;
  // Only while `traceContextOn` says so, and then left to an OpenTelemetry
  // SDK in this process when it propagates W3C Trace Context - see
  // `openTelemetryWritesTraceparent`. Both asked per call: interop pauses
  // while the collector is not taking telemetry, and an SDK may be
  // registered after the application starts.
  const sendsTraceContext = () =>
    traceContextOn() && !openTelemetryWritesTraceparent();

  const open = (
    request: object,
    method: string,
    url: string,
    host: string,
    presetSpanId?: string,
  ) => {
    if (options.ignore?.(url)) {
      return false;
    }
    const span = recorder.open(
      "http",
      `${method} ${host}`,
      {
        "http.method": method,
        "http.url": redactUrlQuery(url, getRedactor()),
      },
      presetSpanId,
    );
    if (span) {
      spans.set(request, span);
      // A no-op unless this request is a model call the fetch observer is
      // reading - see `llm-fetch.integration.ts`.
      attachLlmSpan(span);
    }
    return true;
  };

  const close = (request: object, error?: unknown) => {
    spans.get(request)?.end(error);
    spans.delete(request);
  };

  // --- undici / fetch ------------------------------------------------------
  on<{ request: UndiciRequest }>("undici:request:create", ({ request }) => {
    const origin = String(request.origin ?? "");
    const url = `${origin}${request.path ?? ""}`;
    const host = origin.replace(/^[a-z]+:\/\//i, "");
    const method = (request.method ?? "GET").toUpperCase();
    if (!open(request, method, url, host)) {
      return;
    }
    const trace = currentTrace();
    if (
      !trace ||
      !shouldPropagate(url) ||
      typeof request.addHeader !== "function"
    ) {
      return;
    }
    if (!hasUndiciHeader(request.headers, TRACE_HEADER)) {
      request.addHeader(TRACE_HEADER, trace.traceId);
    }
    if (
      sendsTraceContext() &&
      !hasUndiciHeader(request.headers, TRACEPARENT_HEADER)
    ) {
      const span = spans.get(request);
      const headers = traceContextHeaders(
        trace,
        span?.spanId,
        span !== undefined,
      );
      request.addHeader(TRACEPARENT_HEADER, headers.traceparent);
      if (
        headers.tracestate &&
        !hasUndiciHeader(request.headers, TRACESTATE_HEADER)
      ) {
        request.addHeader(TRACESTATE_HEADER, headers.tracestate);
      }
    }
  });
  on<{ request: UndiciRequest }>("undici:request:trailers", ({ request }) =>
    close(request),
  );
  on<{ request: UndiciRequest; error: unknown }>(
    "undici:request:error",
    ({ request, error }) => close(request, error),
  );

  // --- node:http / node:https ----------------------------------------------
  const describeNodeRequest = (request: NodeClientRequest) => {
    const host = String(request.getHeader?.("host") ?? request.host ?? "");
    const url = `${request.protocol ?? "http:"}//${host}${request.path ?? ""}`;
    return { host, url, method: (request.method ?? "GET").toUpperCase() };
  };

  // Published while headers can still be set (Node 22.12+). On older
  // runtimes there is simply no propagation for this client; `start` below
  // fires after the header block is already on its way.
  on<{ request: NodeClientRequest }>(
    "http.client.request.created",
    ({ request }) => {
      const { url } = describeNodeRequest(request);
      const trace = currentTrace();
      if (!trace || options.ignore?.(url) || !shouldPropagate(url)) {
        return;
      }
      if (!request.getHeader?.(TRACE_HEADER)) {
        request.setHeader?.(TRACE_HEADER, trace.traceId);
      }
      if (sendsTraceContext() && !request.getHeader?.(TRACEPARENT_HEADER)) {
        // The span only opens at `start`, by when the header has gone, so
        // its id is minted here - and only for a call that will have one.
        const recorded = recorder.isRecording();
        const spanId = recorded ? uuidv7() : undefined;
        if (spanId !== undefined) {
          presetSpanIds.set(request, spanId);
        }
        const headers = traceContextHeaders(trace, spanId, recorded);
        request.setHeader?.(TRACEPARENT_HEADER, headers.traceparent);
        if (headers.tracestate && !request.getHeader?.(TRACESTATE_HEADER)) {
          request.setHeader?.(TRACESTATE_HEADER, headers.tracestate);
        }
      }
    },
  );
  on<{ request: NodeClientRequest }>(
    "http.client.request.start",
    ({ request }) => {
      const { host, url, method } = describeNodeRequest(request);
      const presetSpanId = presetSpanIds.get(request);
      presetSpanIds.delete(request);
      if (!open(request, method, url, host, presetSpanId)) {
        return;
      }
      // `close` always fires, with or without a response. An `error` listener
      // would tell more, but adding one changes what an otherwise unhandled
      // request error does to the process.
      request.once?.("close", () =>
        close(
          request,
          request.res
            ? undefined
            : new Error("Request closed with no response"),
        ),
      );
    },
  );
  on<{ request: NodeClientRequest; error: unknown }>(
    "http.client.request.error",
    ({ request, error }) => close(request, error),
  );
  on<{ request: NodeClientRequest }>(
    "http.client.response.finish",
    ({ request }) => close(request),
  );

  return () => {
    for (const [channel, handler] of subscriptions) {
      unsubscribe(channel, handler);
    }
  };
}

/**
 * The W3C headers for one call: the trace the operation arrived in - else
 * the one its trace id maps onto - with the call's own span as the parent the
 * callee sees, so a server span there nests under this client span.
 *
 * `sampled` passes the caller's decision on, as the spec asks of a hop that
 * does not make its own. With no caller, it says whether this operation is
 * being recorded: a callee sampling by its parent then keeps exactly the
 * traces that have a root.
 */
function traceContextHeaders(
  trace: OutgoingTrace,
  spanId: string | undefined,
  recorded: boolean,
): { traceparent: string; tracestate: string | undefined } {
  const received = trace.traceContext;
  return {
    traceparent: formatTraceparent(
      received?.traceId ?? w3cTraceIdOf(trace.traceId),
      spanId === undefined ? randomSpanId() : w3cSpanIdOf(spanId),
      received?.sampled ?? recorded,
    ),
    tracestate: received?.traceState,
  };
}

/** undici keeps headers as a flat `[name, value, ...]` array or a raw string. */
function hasUndiciHeader(headers: unknown, name: string): boolean {
  if (Array.isArray(headers)) {
    for (let index = 0; index < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === name) {
        return true;
      }
    }
    return false;
  }
  return (
    typeof headers === "string" && headers.toLowerCase().includes(`${name}:`)
  );
}
