/**
 * The one definition of "this key names a credential", shared by everything
 * that masks by key - log attributes, captured headers, URL query strings.
 * Two lists that drift apart mean one of the paths quietly stops protecting
 * something the other still does.
 */

/**
 * Words too short or too generic to be matched inside a longer name - `auth`
 * would take `author` with it - but a credential when they are the whole key
 * or its last word: `pwd`, `db_pwd`, `token_auth`, `x-auth`.
 */
const SHORT_WORDS = new Set(["pwd", "auth"]);

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

/**
 * Nouns specific enough to mark a key even run together with other words,
 * where no case or separator shows the word: `passwordconfirm`,
 * `PASSWORDHASH`. Not `secret`, which `secretary` contains.
 */
const SENSITIVE_STEMS = ["password", "passwd", "credential"];

/**
 * Case-insensitive, ignoring the separators a name is written with: `api_key`,
 * `apiKey`, `API-KEY`, `api.key`, `Api Key` and `api[key]` are one key.
 */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_. [\]]/g, "");
}

/**
 * `SMTPPasswordNew` is `smtp password new`: a case change ends a word, and so
 * does the last capital of an acronym followed by a lower-case letter.
 */
function wordsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Walked by hand rather than with `/\d+$/`, which restarts at every digit of a
 * run that does not reach the end - quadratic, on a query-string key the
 * client chose.
 */
function withoutTrailingDigits(key: string): string {
  let end = key.length;
  while (end > 0) {
    const code = key.charCodeAt(end - 1);
    if (code < 48 || code > 57) {
      break;
    }
    end -= 1;
  }
  return key.slice(0, end);
}

export type SensitiveKeyMatcher = (key: string) => boolean;

/**
 * Builds the matcher, with `extraKeys` - the deployment's own `redaction.keys`
 * - matched exactly (after normalising) on top of the built-in rules.
 */
export function createSensitiveKeyMatcher(
  extraKeys: Iterable<string> = [],
): SensitiveKeyMatcher {
  const exact = new Set([...SHORT_WORDS, ...extraKeys].map(normaliseKey));

  return (key) => {
    const normalised = normaliseKey(key);
    // `password2`, `token_1`: a numbered credential is still one.
    const stem = withoutTrailingDigits(normalised);
    if (
      exact.has(normalised) ||
      exact.has(stem) ||
      SENSITIVE_SUFFIXES.some((suffix) => stem.endsWith(suffix)) ||
      SENSITIVE_STEMS.some((word) => normalised.includes(word))
    ) {
      return true;
    }
    const words = wordsOf(key);
    const last = words.length > 0 ? withoutTrailingDigits(words.at(-1)!) : "";
    return (
      SHORT_WORDS.has(last) || words.some((word) => SENSITIVE_WORDS.has(word))
    );
  };
}

export const isSensitiveKeyByDefault = createSensitiveKeyMatcher();
