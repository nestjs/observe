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
  /** `http.queryParamsObfuscateRegex`, global. */
  obfuscateUrl?: RegExp,
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
      // Any header can carry a URL - `referer`, `x-forwarded-uri`,
      // `x-original-url` - and its query string is where the tokens live.
      // Masking is by key, so a value that is no URL comes back untouched.
      headers[key] = redactUrlQuery(value, redactor, obfuscateUrl);
    }
    if (Object.keys(headers).length > 0) {
      // Redacted whole and cut afterwards, as the body is: the rules that
      // recognise a secret by its end - a JWT's last dot, a closing quote, a
      // card's last digits - stop matching once the cut goes through it, and
      // the head of the secret would be sent.
      const redacted = redactor ? redactor.redactAttributes(headers) : headers;
      captured.headers = Object.fromEntries(
        Object.entries(redacted ?? {}).map(([key, value]) => [
          key,
          typeof value === "string"
            ? value.slice(0, MAX_HEADER_VALUE_LENGTH)
            : value,
        ]),
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
    const serialized = serializeBody(request.body, redactor, maxBytes);
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
 *
 * A body that arrived as a string but is JSON (sent as `text/plain`, say) is
 * parsed first, so it is held to the same key rules as one the framework
 * parsed.
 */
function serializeBody(
  body: unknown,
  redactor: LogRedactor | null,
  maxBytes: number,
): string | undefined {
  if (typeof body === "string") {
    const parsed = parseJsonDocument(body);
    if (parsed === undefined) {
      return redactor ? redactor.redactMessage(body) : body;
    }
    body = parsed;
  }
  if (Buffer.isBuffer(body) || typeof body !== "object" || body === null) {
    // A raw buffer is a file or an unparsed stream - nothing readable to show.
    return undefined;
  }
  try {
    const bounded = boundToCap(body, { nodes: maxBytes }, new Set());
    const redacted = redactor
      ? redactor.redactAttributes(bounded as Record<string, unknown>)
      : bounded;
    return JSON.stringify(redacted);
  } catch {
    // Circular, or a getter that throws. Reporting an error must not raise one.
    return undefined;
  }
}

function parseJsonDocument(body: string): object | undefined {
  const first = body.trimStart()[0];
  if (first !== "{" && first !== "[") {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Deeper than the redactor descends, so nothing it would read is cut off. */
const MAX_BOUNDED_DEPTH = 10;

/**
 * A copy of the body holding only the nodes that can still show up in the
 * first `maxBytes` of its JSON, in the order JSON writes them. Every value
 * and key takes at least a byte, so past `maxBytes` of them the rest is cut
 * anyway - and the rest can be enormous: multer turns `f[1000000]=x` into an
 * array of a million holes, each written out as `null`, from one short field.
 */
function boundToCap(
  value: unknown,
  budget: { nodes: number },
  /** The objects above this one, to refuse a cycle as JSON.stringify would. */
  ancestors: Set<object>,
): unknown {
  budget.nodes -= 1;
  // What JSON.stringify would write for it: a Date its ISO string, and so on.
  const toJSON: unknown =
    value !== null && typeof value === "object"
      ? (value as { toJSON?: unknown }).toJSON
      : undefined;
  if (typeof toJSON === "function") {
    value = (toJSON as () => unknown).call(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  if (ancestors.size >= MAX_BOUNDED_DEPTH) {
    return "[REDACTED]";
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (let i = 0; i < value.length && budget.nodes > 0; i++) {
        items.push(boundToCap(value[i], budget, ancestors));
      }
      return items;
    }
    const entries: Record<string, unknown> = {};
    for (const key in value) {
      if (budget.nodes <= 0) {
        break;
      }
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        budget.nodes -= 1;
        entries[key] = boundToCap(
          (value as Record<string, unknown>)[key],
          budget,
          ancestors,
        );
      }
    }
    return entries;
  } finally {
    ancestors.delete(value);
  }
}
