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
 * Values are not inspected, only keys. A regex hunting for token-shaped strings
 * anywhere in a URL mangles ordinary path segments and ids, and a redactor that
 * mangles real data is one somebody switches off.
 */
export function redactUrlQuery(
  url: string,
  /**
   * The deployment's redactor, so its `redaction.keys` apply to a URL as they
   * do to a log attribute. Without one the built-in rules still apply: masking
   * a URL is not something `redaction.enabled: false` switches off.
   */
  redactor?: { isSensitiveKey: SensitiveKeyMatcher } | null,
): string {
  const separator = url.indexOf("?");
  if (separator === -1) {
    return url;
  }

  const path = url.slice(0, separator);
  const rest = url.slice(separator + 1);

  // The fragment is not sent to a server, but `req.url` is not the only caller
  // this may ever have, and splitting it off keeps it out of the query parse.
  const hashAt = rest.indexOf("#");
  const query = hashAt === -1 ? rest : rest.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : rest.slice(hashAt);

  // Parsed and re-serialised rather than pattern-replaced: the parser is what
  // knows that `?a=1&token=x` and `?a=1;token=x` differ, and that a value may
  // contain an escaped `&`.
  const params = new URLSearchParams(query);
  let redactedAny = false;
  // The spread is load-bearing: `params.set` below mutates the same object the
  // iterator walks, so the keys have to be materialised before the loop starts.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const key of [...params.keys()]) {
    if (
      URL_ONLY_SENSITIVE_KEYS.has(normaliseKey(key)) ||
      (redactor ? redactor.isSensitiveKey(key) : isSensitiveKeyByDefault(key))
    ) {
      params.set(key, REDACTED);
      redactedAny = true;
    }
  }

  if (!redactedAny) {
    // Returned untouched so a URL with nothing to hide is stored exactly as it
    // arrived, rather than in URLSearchParams' normalised spelling.
    return url;
  }

  return `${path}?${params.toString()}${fragment}`;
}
