import { RedactionOptions } from "../interfaces/observe-options.interface.js";
import {
  createSensitiveKeyMatcher,
  SensitiveKeyMatcher,
} from "./sensitive-keys.js";

/**
 * Strips secrets out of log lines before they leave the process.
 *
 * This is the only point where redaction can be done safely. Once a line has
 * been written to the shared buffer it is going to be shipped, stored, and
 * indexed on someone else's disk; scrubbing server-side would mean the secret
 * had already crossed the network and been persisted. So this runs in the
 * emitting process, on the way into the buffer, and never after.
 *
 * The default patterns are deliberately high-precision rather than exhaustive.
 * A redactor that mangles ordinary log content gets switched off, and a
 * switched-off redactor protects nothing - so the defaults only match things
 * that are unambiguously credentials. Anything domain-specific belongs in
 * `patterns`.
 *
 * Note what this is not: it is a safety net for secrets that leak into logs by
 * accident, not a guarantee that none can. Deliberately logging a credential in
 * a shape nothing here matches will still ship it.
 */

const DEFAULT_REPLACEMENT = "[REDACTED]";

/**
 * Key names recognised inside free text, as `key=value` or `"key": "value"`.
 * Spelled for a regex, where the separators are still present. Unanchored on
 * the left, so a compound name - `resetToken=`, `client_secret=` - matches on
 * its ending, the same way `sensitive-keys.ts` matches a structured key.
 */
const TEXT_KEY_ALTERNATION = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "access[_-]?token",
  "refresh[_-]?token",
  "id[_-]?token",
  "api[_-]?key",
  "authorization",
  "auth",
  "credentials?",
  "private[_-]?key",
  "access[_-]?key",
  "secret[_-]?key",
  "session[_-]?id",
  "set-cookie",
  "cookie",
].join("|");

interface CompiledRule {
  pattern: RegExp;
  /**
   * Replacement applied to a match. A function lets a rule keep the part that
   * identifies what was redacted (the key name, the scheme) while masking only
   * the value.
   */
  replace: (replacement: string, ...groups: string[]) => string;
}

/**
 * `literalValuesOnly` is the variant for source code, where the text either
 * side of a `:` or `=` is mostly identifiers: `const token = await sign(user)`
 * assigns no secret, and masking `await` would shred every frame that mentions
 * a credential by name. In source a secret is a literal, so only a quoted
 * value is masked there.
 */
function buildDefaultRules(literalValuesOnly = false): CompiledRule[] {
  const value = literalValuesOnly
    ? "(?:\"[^\"\\n]*\"|'[^'\\n]*'|`[^`]*`)"
    : "(?:\"[^\"]*\"|'[^']*'|(?:Bearer|Basic|Token)\\s+\\S+|[^\\s,;&}\"']+)";
  return [
    // PEM blocks first: they span lines and would otherwise be partially eaten
    // by the narrower rules below.
    {
      pattern:
        /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
      replace: (replacement) => replacement,
    },
    // Authorization schemes: `Bearer eyJ...`, `Basic dXNlcjpwYXNz`.
    //
    // Must precede the key=value rule. That rule's value stops at whitespace, so
    // on `Authorization: Basic dXNlcjpwYXNz` it would consume only the word
    // "Basic" and leave the credential itself sitting in the line.
    {
      pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
      replace: (replacement, scheme) => `${scheme} ${replacement}`,
    },
    // key=value / "key": "value". Keeps the key so the line still says what was
    // removed - a log reading `password=[REDACTED]` is far more useful than one
    // where the whole pair vanished.
    //
    // The value alternation matches a scheme-prefixed credential before the bare
    // form, so an already-masked `Authorization: Bearer [REDACTED]` collapses to
    // a single `[REDACTED]` rather than stacking two.
    {
      pattern: new RegExp(
        `((?:${TEXT_KEY_ALTERNATION})["']?\\s*[:=]\\s*)${value}`,
        "gi",
      ),
      replace: (replacement, prefix) => `${prefix}${replacement}`,
    },
    // Bare JWTs - they show up outside any header often enough to matter.
    {
      pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
      replace: (replacement) => replacement,
    },
    // AWS access key ids. Distinctive enough to match on sight; the matching
    // secret key has no distinguishing shape and is left to the key=value rule.
    {
      pattern:
        /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
      replace: (replacement) => replacement,
    },
  ];
}

/**
 * Card numbers, validated rather than pattern-matched.
 *
 * A bare 13-19 digit run matches plenty of innocent things - order ids, trace
 * ids, timestamps concatenated together - so the digits are Luhn-checked before
 * anything is masked. That turns a rule which would otherwise shred numeric log
 * data into one that only fires on something genuinely card-shaped.
 */
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

function isLuhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Longest attribute tree the walker will descend.
 *
 * Attributes come from JSON.parse so they cannot be cyclic, but they can be
 * arbitrarily deep, and this runs on every log line.
 */
const MAX_ATTRIBUTE_DEPTH = 8;

export class LogRedactor {
  private readonly rules: CompiledRule[];
  private readonly sourceRules: CompiledRule[];
  private readonly matchesSensitiveKey: SensitiveKeyMatcher;
  private readonly replacement: string;
  private readonly redactCards: boolean;

  constructor(options: RedactionOptions = {}) {
    this.replacement = options.replacement ?? DEFAULT_REPLACEMENT;
    this.redactCards = options.useDefaultPatterns !== false;

    const defaults =
      options.useDefaultPatterns === false ? [] : buildDefaultRules();
    const extra: CompiledRule[] = (options.patterns ?? []).map((pattern) => ({
      // Rebuilt with the global flag: a caller-supplied pattern without /g would
      // silently redact only the first occurrence in a line.
      pattern: pattern.global
        ? pattern
        : new RegExp(pattern.source, pattern.flags + "g"),
      replace: (replacement: string) => replacement,
    }));

    this.rules = [...defaults, ...extra];
    this.sourceRules = [
      ...(options.useDefaultPatterns === false ? [] : buildDefaultRules(true)),
      ...extra,
    ];
    this.matchesSensitiveKey = createSensitiveKeyMatcher(options.keys);
  }

  /**
   * Whether a key names a credential - the built-in rules plus the configured
   * `keys`. Exposed so a caller masking by key somewhere this class does not
   * reach (a URL's query string) is held to the same list.
   */
  isSensitiveKey(key: string): boolean {
    return this.matchesSensitiveKey(key);
  }

  redactMessage(message: string): string {
    return this.apply(message, this.rules, false);
  }

  /**
   * Redacts lines of source code read for a code frame.
   *
   * Source is shipped for the same reason a message is, and a literal in it -
   * `password: "hunter2"`, a pasted key - is as much a secret there as in a
   * log line. The lines are redacted as one text so a block spanning several
   * (a PEM key in a template literal) is still seen whole, and every match
   * keeps its newlines so the result has the same line count: a frame's
   * `firstLine` and highlighted `line` index into this array.
   */
  redactSource(lines: string[]): string[] {
    return this.apply(lines.join("\n"), this.sourceRules, true).split("\n");
  }

  private apply(
    text: string,
    rules: CompiledRule[],
    keepNewlines: boolean,
  ): string {
    let output = text;
    const keep = (match: string, masked: string) =>
      keepNewlines
        ? masked + "\n".repeat(match.split("\n").length - 1)
        : masked;

    for (const rule of rules) {
      output = output.replace(rule.pattern, (...args) => {
        // String.replace passes offset and the whole string after the groups.
        const groups = args.slice(1, -2).map((group) => group ?? "");
        return keep(args[0], rule.replace(this.replacement, ...groups));
      });
    }

    if (this.redactCards) {
      output = output.replace(CARD_CANDIDATE, (match) => {
        const digits = match.replace(/[ -]/g, "");
        return digits.length >= 13 && isLuhnValid(digits)
          ? this.replacement
          : match;
      });
    }

    return output;
  }

  redactAttributes(
    attributes: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!attributes) {
      return attributes;
    }
    return this.redactValue(attributes, 0) as Record<string, unknown>;
  }

  private redactValue(value: unknown, depth: number): unknown {
    if (depth > MAX_ATTRIBUTE_DEPTH) {
      return this.replacement;
    }

    if (typeof value === "string") {
      return this.redactMessage(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          // A sensitive key masks its value whatever the shape - an object under
          // `credentials` is exactly what must not be walked into and partially
          // preserved.
          this.matchesSensitiveKey(key)
            ? this.replacement
            : this.redactValue(item, depth + 1),
        ]),
      );
    }
    return value;
  }
}
