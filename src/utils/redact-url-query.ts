import {
  isSensitiveKeyByDefault,
  normaliseKey,
  SensitiveKeyMatcher,
} from "./sensitive-keys.js";

/**
 * Query-string keys masked on top of the shared list in `sensitive-keys.ts`.
 *
 * These are sensitive in a URL and ordinary anywhere else, which is why they
 * are not in the shared list: `?code=` is an OAuth authorization code and
 * `?key=` an API key, but a log attribute called `code` is an error code and
 * masking it would cost more than it protects.
 */
const URL_ONLY_SENSITIVE_KEYS = new Set(["code", "state", "sig", "key"]);

export const REDACTED = "[REDACTED]";

/** `REDACTED` as a URL carries it. */
const MASKED_VALUE = encodeURIComponent(REDACTED);

/**
 * How many URLs deep a value is read for keys of its own. The client chooses
 * the depth (`?next=` holding a URL whose `next=` holds another), and each
 * level is another parse, so past this a value that still holds one is masked
 * whole.
 */
const MAX_NESTED_URLS = 4;

/**
 * Longest value read as JSON (tRPC's `input`, a `filter`). Parsing is linear,
 * but this runs on the request path, and a value this long is no longer a
 * filter anybody reads in a trace.
 */
const MAX_JSON_VALUE_LENGTH = 16 * 1024;
const MAX_JSON_DEPTH = 32;

type KeyTest = (key: string) => boolean;

/**
 * Masks the values of sensitive query parameters in a request URL.
 *
 * Applied by default, unlike `queryParamsObfuscateRegex`, which is opt-in and
 * so protects only the deployments that already know to ask. The URL of a
 * request is stored on every row of `request_telemetry` and rendered in the UI,
 * and the things routinely carried in a query string - password reset tokens,
 * invite tokens, OAuth codes, signed URL signatures - are exactly the things
 * that must not be readable there weeks later.
 *
 * Keys are kept and only values replaced: knowing a request carried a `token`
 * is useful when reading a trace, and knowing which token is not.
 *
 * Values are not hunted for token-shaped strings - a regex doing that mangles
 * ordinary path segments and ids, and a redactor that mangles real data is one
 * somebody switches off. But a value that is itself a URL (`returnTo`, `next`)
 * or a JSON document carries keys of its own, and those are held to the same
 * rules. So are the parameters a path carries behind `;` and a fragment
 * behind `#`: neither is a query string to URLSearchParams, but a server that
 * reads `;jsessionid=` and an OAuth callback's `#access_token=` both are.
 *
 * Masking is done in place, one parameter at a time. A parameter with nothing
 * to hide keeps the spelling it arrived with even beside a masked one, so a
 * `queryParamsObfuscateRegex` written for what requests carry still finds it.
 */
export function redactUrlQuery(
  url: string,
  /**
   * The deployment's redactor, so its `redaction.keys` apply to a URL as they
   * do to a log attribute. Without one the built-in rules still apply: masking
   * a URL is not something `redaction.enabled: false` switches off.
   */
  redactor?: { isSensitiveKey: SensitiveKeyMatcher } | null,
  /**
   * `http.queryParamsObfuscateRegex`, already made global by
   * `toGlobalRegExp`. Applied here, after the key rules, so every URL the
   * agent records - the request's, a captured `referer`, an outgoing call's -
   * is held to it, not only the one caller that used to apply it.
   */
  obfuscate?: RegExp,
): string {
  const isSharedSensitive: KeyTest = redactor
    ? (key) => redactor.isSensitiveKey(key)
    : isSensitiveKeyByDefault;
  const isSensitive: KeyTest = (key) =>
    URL_ONLY_SENSITIVE_KEYS.has(normaliseKey(key)) || isSharedSensitive(key);

  const redacted = redactUrl(url, isSensitive, isSharedSensitive, 0);
  return obfuscate ? redacted.replaceAll(obfuscate, REDACTED) : redacted;
}

/**
 * Rebuilds a RegExp with the global flag when it lacks one, keeping the
 * original otherwise. `replaceAll` refuses a non-global pattern outright -
 * inside a request hook, where that would answer every traced request with a
 * 500.
 */
export function toGlobalRegExp(
  pattern: RegExp | undefined,
): RegExp | undefined {
  if (!pattern || pattern.global) {
    return pattern;
  }
  return new RegExp(pattern.source, pattern.flags + "g");
}

function redactUrl(
  url: string,
  isSensitive: KeyTest,
  isSharedSensitive: KeyTest,
  depth: number,
): string {
  const queryAt = url.indexOf("?");
  const hashAt = url.indexOf("#");
  const pathEnd = Math.min(
    queryAt === -1 ? url.length : queryAt,
    hashAt === -1 ? url.length : hashAt,
  );
  const redactParamsOf = (text: string, separators: string) =>
    redactParams(text, separators, isSensitive, isSharedSensitive, depth);

  // Behind the first `;` of the path: Fastify's `useSemicolonDelimiter` reads
  // it as the query, a servlet container as `;name=value` pairs.
  const path = url.slice(0, pathEnd);
  const pathParamsAt = path.indexOf(";");
  let output =
    pathParamsAt === -1
      ? path
      : path.slice(0, pathParamsAt + 1) +
        redactParamsOf(path.slice(pathParamsAt + 1), ";&");

  if (pathEnd === queryAt) {
    const queryEnd = hashAt > queryAt ? hashAt : url.length;
    output += "?" + redactParamsOf(url.slice(queryAt + 1, queryEnd), "&");
  }
  const fragmentAt = hashAt !== -1 && hashAt >= pathEnd ? hashAt : -1;
  if (fragmentAt !== -1) {
    output += "#" + redactParamsOf(url.slice(fragmentAt + 1), "&");
  }

  // Compared rather than tracked: what masked nothing comes back as the very
  // string that arrived, not a rebuilt copy of it.
  return output === url ? url : output;
}

function redactParams(
  text: string,
  separators: string,
  isSensitive: KeyTest,
  isSharedSensitive: KeyTest,
  depth: number,
): string {
  let output = "";
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && !separators.includes(text[i])) {
      continue;
    }
    output += redactParam(
      text.slice(start, i),
      isSensitive,
      isSharedSensitive,
      depth,
    );
    if (i < text.length) {
      output += text[i];
    }
    start = i + 1;
  }
  return output;
}

function redactParam(
  param: string,
  isSensitive: KeyTest,
  isSharedSensitive: KeyTest,
  depth: number,
): string {
  const equalsAt = param.indexOf("=");
  // `?token` alone, or an anchor named after a credential (`#api-key`):
  // nothing is carried, so there is nothing to mask.
  if (equalsAt === -1 || equalsAt === param.length - 1) {
    return param;
  }
  const rawKey = param.slice(0, equalsAt);
  const rawValue = param.slice(equalsAt + 1);
  const key = decodeComponent(rawKey);
  // A path segment ending in `?x` rather than `?x=` puts the name into the
  // key: `/items/1?x?key=abc` is `key=abc` to whatever reads the inner URL.
  const innerKeyAt = key.lastIndexOf("?");
  if (
    isSensitive(key) ||
    (innerKeyAt !== -1 && isSensitive(key.slice(innerKeyAt + 1)))
  ) {
    return `${rawKey}=${MASKED_VALUE}`;
  }

  const value = decodeComponent(rawValue);
  const redacted = redactValue(value, isSensitive, isSharedSensitive, depth);
  if (redacted === value) {
    return param;
  }
  // Written back the way it came: still raw if it arrived raw, encoded once
  // if it arrived encoded.
  return `${rawKey}=${value === rawValue ? redacted : encodeURIComponent(redacted)}`;
}

function redactValue(
  value: string,
  isSensitive: KeyTest,
  isSharedSensitive: KeyTest,
  depth: number,
): string {
  const first = value.trimStart()[0];
  if (
    (first === "{" || first === "[") &&
    value.length <= MAX_JSON_VALUE_LENGTH
  ) {
    const redacted = redactJson(value, isSharedSensitive);
    if (redacted !== undefined) {
      return redacted;
    }
  }
  if (!/[?#;]/.test(value)) {
    return value;
  }
  if (depth + 1 >= MAX_NESTED_URLS) {
    return REDACTED;
  }
  return redactUrl(value, isSensitive, isSharedSensitive, depth + 1);
}

/**
 * The value with its sensitive members masked, the value itself when nothing
 * was, or `undefined` when it is not JSON after all.
 */
function redactJson(value: string, isSensitive: KeyTest): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  let maskedAny = false;
  const walk = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== "object") {
      return node;
    }
    if (depth > MAX_JSON_DEPTH) {
      maskedAny = true;
      return REDACTED;
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (isSensitive(key)) {
        maskedAny = true;
        out[key] = REDACTED;
      } else {
        out[key] = walk(item, depth + 1);
      }
    }
    return out;
  };
  const redacted = walk(parsed, 0);
  return maskedAny ? JSON.stringify(redacted) : value;
}

/** What a server reads for a key or value, or the raw text if it cannot. */
function decodeComponent(raw: string): string {
  if (!raw.includes("%") && !raw.includes("+")) {
    return raw;
  }
  try {
    return decodeURIComponent(raw.replaceAll("+", " "));
  } catch {
    // A malformed escape: no server reads it as anything else either.
    return raw;
  }
}
