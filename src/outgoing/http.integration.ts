import { subscribe, unsubscribe } from "diagnostics_channel";
import { LogRedactor } from "../utils/log-redactor.js";
import { redactUrlQuery } from "../utils/redact-url-query.js";
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
   * for - your own services, say, and not third parties.
   * @default true
   */
  propagateTraceId?: boolean | ((url: string) => boolean);
}

const TRACE_HEADER = "x-request-id";

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
  currentTraceId: () => string | undefined,
  options: OutgoingHttpOptions = {},
  /**
   * Read per request rather than passed once: the redactor is configured
   * after the module's options resolve, which can be after this subscribes.
   */
  getRedactor: () => LogRedactor | null = () => null,
): () => void {
  const spans = new WeakMap<object, OpenOutgoingSpan>();
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

  const open = (request: object, method: string, url: string, host: string) => {
    if (options.ignore?.(url)) {
      return false;
    }
    const span = recorder.open("http", `${method} ${host}`, {
      "http.method": method,
      "http.url": redactUrlQuery(url, getRedactor()),
    });
    if (span) {
      spans.set(request, span);
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
    const traceId = currentTraceId();
    if (
      traceId &&
      shouldPropagate(url) &&
      typeof request.addHeader === "function" &&
      !hasUndiciHeader(request.headers, TRACE_HEADER)
    ) {
      request.addHeader(TRACE_HEADER, traceId);
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
      const traceId = currentTraceId();
      if (
        traceId &&
        !options.ignore?.(url) &&
        shouldPropagate(url) &&
        !request.getHeader?.(TRACE_HEADER)
      ) {
        request.setHeader?.(TRACE_HEADER, traceId);
      }
    },
  );
  on<{ request: NodeClientRequest }>(
    "http.client.request.start",
    ({ request }) => {
      const { host, url, method } = describeNodeRequest(request);
      if (!open(request, method, url, host)) {
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
