/**
 * The one definition of "this key names a credential", shared by everything
 * that masks by key - log attributes, captured headers, URL query strings.
 * Two lists that drift apart mean one of the paths quietly stops protecting
 * something the other still does.
 */

/**
 * Keys masked only when they are the whole key. Too short or too generic to be
 * matched inside a longer name: `auth` would take `author` with it.
 */
const EXACT_KEYS = ["pwd", "auth"];

/**
 * What a credential's name ends in. Real applications do not call the
 * parameter `token`; they call it `resetToken`, `client_secret`,
 * `X-Amz-Signature`, `x-api-key` - so an exact-match list protects the
 * spelling in the documentation and little else.
 *
 * A suffix rather than a substring, which is what keeps this precise: a
 * credential's name ends in the noun, and the keys that merely mention one -
 * `maxTokens`, `tokenCount`, `secretary` - do not.
 */
const SENSITIVE_SUFFIXES = [
  "password",
  "passwd",
  "secret",
  "token",
  "credential",
  "credentials",
  "signature",
  "jwt",
  "cookie",
  "apikey",
  "privatekey",
  "accesskey",
  "secretkey",
  "sessionid",
  "authorization",
];

/**
 * Words that mark a key as sensitive wherever they sit in it, for the names
 * that put the noun first: `passwordConfirmation`, `secret_value`. `token` is
 * deliberately absent - `tokenCount` and `tokenLimit` are ordinary numbers.
 */
const SENSITIVE_WORDS = new Set([
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
]);

/** Case-insensitive, ignoring `-` and `_`: `api_key`, `apiKey`, `API-KEY` are one key. */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

export type SensitiveKeyMatcher = (key: string) => boolean;

/**
 * Builds the matcher, with `extraKeys` - the deployment's own `redaction.keys`
 * - matched exactly (after normalising) on top of the built-in rules.
 */
export function createSensitiveKeyMatcher(
  extraKeys: Iterable<string> = [],
): SensitiveKeyMatcher {
  const exact = new Set([...EXACT_KEYS, ...extraKeys].map(normaliseKey));

  return (key) => {
    const normalised = normaliseKey(key);
    // `password2`, `token_1`: a numbered credential is still one.
    const stem = normalised.replace(/\d+$/, "");
    return (
      exact.has(normalised) ||
      SENSITIVE_SUFFIXES.some((suffix) => stem.endsWith(suffix)) ||
      wordsOf(key).some((word) => SENSITIVE_WORDS.has(word))
    );
  };
}

export const isSensitiveKeyByDefault = createSensitiveKeyMatcher();
