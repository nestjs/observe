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

interface PatternRule {
  pattern: RegExp;
  /**
   * Replacement applied to a match. A function lets a rule keep the part that
   * identifies what was redacted (the key name, the scheme) while masking only
   * the value.
   */
  replace: (replacement: string, ...groups: string[]) => string;
}

/**
 * A rule a regex cannot express in linear time, written as a scan instead.
 * `mask` turns a matched secret into its replacement.
 */
interface ScanRule {
  scan: (text: string, mask: (secret: string) => string) => string;
}

type CompiledRule = PatternRule | ScanRule;

/**
 * Where a bare token may start: not inside a word, but also right after a
 * percent escape (`%2FeyJ...`, a URL-encoded path) or a JSON escape
 * (`\neyJ...`, `\u0022eyJ...`), whose last character would otherwise read as
 * the token's own.
 */
const TOKEN_START = String.raw`(?:(?<![A-Za-z0-9_-])|(?<=%[0-9A-Fa-f]{2})|(?<=\\[nrtbf])|(?<=\\u[0-9A-Fa-f]{4}))`;

/**
 * A run of base64url characters at least `min` long. Written as `{min}` and
 * then `*` rather than `{min,}`: V8 keeps a backtrack entry per character of a
 * counted quantifier, and a run of ~5.6 MB exhausted its stack, so recording
 * the error replaced it with a RangeError.
 */
const tokenRun = (min: number) =>
  min === 0 ? "[A-Za-z0-9_-]*" : `[A-Za-z0-9_-]{${min}}[A-Za-z0-9_-]*`;

const PEM_BEGIN = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g;
const PEM_END = /-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g;
/** The shortest line of base64 taken for the body of a key with no END line. */
const MIN_PEM_BODY_LINE = 16;

/**
 * PEM private keys, BEGIN through END.
 *
 * A scan rather than `BEGIN[\s\S]*?END`: on a BEGIN marker with no END after
 * it that lazy run read to the end of the text before failing, and every
 * later marker read it again - quadratic, on an error message a client can
 * fill. Here the END markers are found once, and each BEGIN is paired with the
 * first one after it, as the lazy run did.
 *
 * A BEGIN with no END after it is a key cut off - by a truncated message, the
 * edge of a code frame - and its body is masked as far as it still reads as
 * one: lines of base64, the first at least `MIN_PEM_BODY_LINE` long. A marker
 * that heads no such line (quoted in prose, or in code that checks for one) is
 * left as it was.
 */
function scanPemBlocks(text: string, mask: (secret: string) => string) {
  if (!text.includes("PRIVATE KEY-----")) {
    return text;
  }
  const ends: number[][] = [];
  for (const match of text.matchAll(PEM_END)) {
    ends.push([match.index, match.index + match[0].length]);
  }

  let output = "";
  let copiedTo = 0;
  let nextEnd = 0;
  const begin = new RegExp(PEM_BEGIN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = begin.exec(text))) {
    const bodyFrom = match.index + match[0].length;
    while (nextEnd < ends.length && ends[nextEnd][0] < bodyFrom) {
      nextEnd++;
    }
    const blockEnd =
      nextEnd < ends.length ? ends[nextEnd++][1] : pemBodyEnd(text, bodyFrom);
    if (blockEnd === undefined) {
      continue;
    }
    output +=
      text.slice(copiedTo, match.index) +
      mask(text.slice(match.index, blockEnd));
    copiedTo = blockEnd;
    begin.lastIndex = blockEnd;
  }
  return copiedTo === 0 ? text : output + text.slice(copiedTo);
}

/**
 * Where the base64 lines after a BEGIN marker stop, or `undefined` when none
 * follows it. A line break may be written raw or JSON-escaped.
 */
function pemBodyEnd(text: string, from: number): number | undefined {
  let end: number | undefined;
  let at = from;
  for (let line = 0; ; line++) {
    const breakLength = lineBreakAt(text, at);
    if (breakLength === 0) {
      return end;
    }
    let runEnd = at + breakLength;
    while (
      runEnd < text.length &&
      (text[runEnd] === " " || text[runEnd] === "\t")
    ) {
      runEnd++;
    }
    const runStart = runEnd;
    while (runEnd < text.length && isBase64Char(text.charCodeAt(runEnd))) {
      runEnd++;
    }
    const length = runEnd - runStart;
    if (length === 0 || (line === 0 && length < MIN_PEM_BODY_LINE)) {
      return end;
    }
    end = runEnd;
    at = runEnd;
  }
}

function lineBreakAt(text: string, at: number): number {
  if (text[at] === "\n") {
    return 1;
  }
  if (text[at] === "\r") {
    return text[at + 1] === "\n" ? 2 : 1;
  }
  if (text[at] === "\\") {
    if (text[at + 1] === "n") {
      return 2;
    }
    if (text[at + 1] === "r" && text[at + 2] === "\\" && text[at + 3] === "n") {
      return 4;
    }
  }
  return 0;
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  );
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
    { scan: scanPemBlocks },
    // Authorization schemes: `Bearer eyJ...`, `Basic dXNlcjpwYXNz`.
    //
    // Must precede the key=value rule. That rule's value stops at whitespace, so
    // on `Authorization: Basic dXNlcjpwYXNz` it would consume only the word
    // "Basic" and leave the credential itself sitting in the line.
    {
      pattern:
        /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8}[A-Za-z0-9._~+/=-]*/gi,
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
    // A signed one has three parts; an encrypted one (JWE) five, the second
    // of them empty under `alg: dir`.
    //
    // Must not follow a token character, rather than `\b`: a hyphen is a word
    // boundary but also a token character, so under `\b` every `eyJ` in a run
    // like `eyJ-eyJ-eyJ-...` started a match that rescanned the rest of the
    // run - quadratic, on a line a caller can fill.
    {
      pattern: new RegExp(
        `${TOKEN_START}eyJ${tokenRun(4)}\\.` +
          `(?:${tokenRun(0)}\\.${tokenRun(4)}\\.${tokenRun(4)}\\.${tokenRun(0)}` +
          `|${tokenRun(4)}\\.${tokenRun(0)})`,
        "g",
      ),
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
const CARD_CANDIDATE = /(?:\b|(?<=\\[nrtbf]))\d(?:[ -]?\d){12,18}\b/g;

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
      if ("scan" in rule) {
        output = rule.scan(output, (secret) => keep(secret, this.replacement));
        continue;
      }
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
