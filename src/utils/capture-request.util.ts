import { LogRedactor } from "./log-redactor.js";
import { redactUrlQuery } from "./redact-url-query.js";

/**
 * Headers recorded when the application names none. Chosen for what they are
 * not: nothing here authenticates the caller, identifies a person or carries a
 * session - no `authorization`, `cookie`, `x-forwarded-for` or custom `x-*`.
 */
export const DEFAULT_CAPTURED_HEADERS = [
  "accept",
  "content-length",
  "content-type",
  "host",
  "origin",
  "referer",
  "user-agent",
] as const;

export const DEFAULT_CAPTURED_BODY_BYTES = 2048;
const MAX_CAPTURED_BODY_BYTES = 16 * 1024;
const MAX_HEADER_VALUE_LENGTH = 512;

export interface HttpCaptureOptions {
  /**
   * Names of the request headers to record with a failed request, or `false`
   * to record none. Matched case-insensitively. Values still pass through
   * redaction, so naming `authorization` here records `[REDACTED]`.
   * @default DEFAULT_CAPTURED_HEADERS
   */
  headers?: readonly string[] | false;
  /**
   * Record the parsed request body of a failed request. Off by default: a body
   * is the application's own data, and whether it may leave the process is
   * not something an agent can decide. `maxBytes` caps the serialized size
   * (default 2048, at most 16384); what does not fit is cut, and marked so.
   * @default false
   */
  body?: boolean | { maxBytes?: number };
  /**
   * Also capture requests that took at least this long, failed or not - the
   * inputs behind a slow request are as hard to guess as those behind a
   * failing one. Unset, only failed requests are captured.
   * @example 2000
   * @default undefined
   */
  slowerThanMs?: number;
}

export interface CapturedRequest {
  headers?: Record<string, string>;
  body?: string;
  bodyTruncated?: true;
}

interface RequestLike {
  headers?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Whether a finished request is one whose inputs are worth keeping: it
 * failed, or it ran past the configured threshold. Never the ordinary
 * request - that keeps both the volume and the exposure to the exceptions
 * rather than the traffic.
 */
export function shouldCaptureRequest(
  snapshot: { error?: unknown; duration?: number },
  options: HttpCaptureOptions | false | undefined,
): boolean {
  if (options === false) {
    return false;
  }
  if (snapshot.error) {
    return true;
  }
  const threshold = options?.slowerThanMs;
  return (
    typeof threshold === "number" &&
    threshold > 0 &&
    typeof snapshot.duration === "number" &&
    snapshot.duration >= threshold
  );
}

/**
 * What to record of a request `shouldCaptureRequest` picked, or `undefined`
 * for nothing. Everything passes through the same redactor as error messages
 * and forwarded logs - sensitive keys by name, secrets by pattern - before it
 * is handed back.
 */
export function captureRequest(
  req: unknown,
  options: HttpCaptureOptions | false | undefined,
  redactor: LogRedactor | null,
): CapturedRequest | undefined {
  if (options === false || typeof req !== "object" || req === null) {
    return undefined;
  }
  const request = req as RequestLike;
  const captured: CapturedRequest = {};

  const headerNames = options?.headers ?? DEFAULT_CAPTURED_HEADERS;
  if (headerNames && request.headers) {
    const headers: Record<string, unknown> = {};
    for (const name of headerNames) {
      const key = name.toLowerCase();
      const value = request.headers[key];
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const bounded = value.slice(0, MAX_HEADER_VALUE_LENGTH);
      // A referer is a URL, and its query string is where the tokens live.
      headers[key] =
        key === "referer" ? redactUrlQuery(bounded, redactor) : bounded;
    }
    if (Object.keys(headers).length > 0) {
      captured.headers = (
        redactor ? redactor.redactAttributes(headers) : headers
      ) as Record<string, string>;
    }
  }

  if (options?.body && request.body !== undefined && request.body !== null) {
    const maxBytes = Math.min(
      typeof options.body === "object" && options.body.maxBytes
        ? options.body.maxBytes
        : DEFAULT_CAPTURED_BODY_BYTES,
      MAX_CAPTURED_BODY_BYTES,
    );
    const serialized = serializeBody(request.body, redactor);
    if (serialized !== undefined) {
      if (Buffer.byteLength(serialized) > maxBytes) {
        const bytes = Buffer.from(serialized);
        // Back off to a character boundary: a cut through a multi-byte
        // character decodes to U+FFFD, three bytes where one was kept, and
        // the body would come out over the cap it was just cut to.
        let end = maxBytes;
        while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
          end -= 1;
        }
        captured.body = bytes.subarray(0, end).toString("utf8");
        captured.bodyTruncated = true;
      } else {
        captured.body = serialized;
      }
    }
  }

  return captured.headers || captured.body !== undefined ? captured : undefined;
}

/**
 * Redaction runs on the parsed structure, before serialization and before the
 * cut - key-based rules need the keys, and truncating first could ship the
 * surviving half of a secret.
 */
function serializeBody(
  body: unknown,
  redactor: LogRedactor | null,
): string | undefined {
  if (typeof body === "string") {
    return redactor ? redactor.redactMessage(body) : body;
  }
  if (Buffer.isBuffer(body) || typeof body !== "object") {
    // A raw buffer is a file or an unparsed stream - nothing readable to show.
    return undefined;
  }
  try {
    const redacted = redactor
      ? redactor.redactAttributes(body as Record<string, unknown>)
      : body;
    return JSON.stringify(redacted);
  } catch {
    // Circular, or a getter that throws. Reporting an error must not raise one.
    return undefined;
  }
}
