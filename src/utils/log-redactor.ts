import { RedactionOptions } from "../interfaces/observe-options.interface.js";
import { stripAnsi } from "./log-line.parser.js";
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
 * A name followed by `:`, `=`, `:=` or `=>`, as free text writes a pair:
 * `password=x`, `"token": "x"`, `\"secret\":\"x\"` (JSON inside a string),
 * `'password' => 'x'` (util.inspect of a Map), `api.key: x`, `auth[token]=x`.
 * Not `==`, which compares rather than assigns, and `=>` only after a quoted
 * name, as util.inspect writes one - otherwise it is an arrow function. Must
 * not start inside a name,
 * so each name is tried once, from its first character; a bracket is not part
 * of the name's own run, so `[token=x]` is a name after a bracket.
 */
const KEY_CANDIDATE =
  /(?<![\w$.-])((?:\\?["'])?)([A-Za-z_$][\w$.-]*(?:\[[\w$.-]*\])*)((?:\\?["'])?)[ \t]*(:=|=>|:|=(?!=))[ \t]*/g;

/**
 * What every name the shared matcher calls sensitive contains, written
 * without separators. Tested first so the matcher - which splits a name into
 * words - runs only for the few names that could be one.
 */
const KEY_STEMS = /pass|pwd|secret|token|auth|cred|key|sig|jwt|cookie|session/i;

/**
 * Names whose value is a whole header: a scheme and a credential
 * (`Authorization: ApiKey sk_...`), or every cookie of a `Cookie` line.
 */
const HEADER_KEY = /(?:authorization|cookie)$/;

/** Where a bare value ends: what the old rule's `[^\s,;&}"']` stopped at. */
const BARE_VALUE_END = /[\s,;&}"']/;
/**
 * Where a header value ends: the line, a quote, or the object it sits in. Not
 * a comma - a Digest credential is a list of them.
 */
const HEADER_VALUE_END = /[\r\n"'\\}]/;
const SCHEME_WORD = /^(?:bearer|basic|token)$/i;

/**
 * `key=value` / `"key": "value"`, the value masked and the key kept - a log
 * reading `password=[REDACTED]` is far more useful than one where the whole
 * pair vanished.
 *
 * A scan rather than a regex, for what a regex could not read: a quoted value
 * past the quotes it escapes, JSON inside a string (`\"password\":\"x\"`), a
 * value cut off before its closing quote, an object or array under a
 * sensitive name, a header that runs past its first space. Every character is
 * read a bounded number of times: a value is read once, and the scan resumes
 * after it.
 *
 * The name is held to the same matcher as an attribute's key - the
 * deployment's `redaction.keys` included - so free text and structured data
 * cannot drift apart.
 *
 * `literalValuesOnly` is the variant for source code, where the text either
 * side of a `:` or `=` is mostly identifiers: `const token = await sign(user)`
 * assigns no secret, and masking `await` would shred every frame that mentions
 * a credential by name. In source a secret is a literal, so only a quoted
 * value is masked there.
 */
function keyValueRule(
  isSensitiveKey: SensitiveKeyMatcher,
  checkEveryKey: boolean,
  literalValuesOnly: boolean,
): ScanRule {
  const isSensitive = (key: string) => {
    const bare = key.replace(/[-_. [\]]/g, "");
    return (checkEveryKey || KEY_STEMS.test(bare)) && isSensitiveKey(key);
  };
  return {
    scan: (text, mask) => {
      const candidate = new RegExp(KEY_CANDIDATE.source, "g");
      let output = "";
      let copiedTo = 0;
      let match: RegExpExecArray | null;
      while ((match = candidate.exec(text))) {
        const key = match[2];
        if ((match[4] === "=>" && !match[3]) || !isSensitive(key)) {
          continue;
        }
        const valueStart = match.index + match[0].length;
        // `"token=" + token`: a quote opened before the name and not closed
        // after it means the pair is inside a string, and a value starting
        // with that quote is the string ending, not a value.
        const enclosing = match[3] ? "" : match[1].replace("\\", "");
        if (
          enclosing &&
          (text[valueStart] === enclosing ||
            (text[valueStart] === "\\" && text[valueStart + 1] === enclosing))
        ) {
          continue;
        }
        const header = HEADER_KEY.test(key.toLowerCase().replace(/[-_]/g, ""));
        const valueEnd = readValue(text, valueStart, literalValuesOnly, header);
        if (valueEnd === -1) {
          continue;
        }
        output += text.slice(copiedTo, valueStart);
        output += mask(text.slice(valueStart, valueEnd));
        copiedTo = valueEnd;
        candidate.lastIndex = valueEnd;
      }
      return copiedTo === 0 ? text : output + text.slice(copiedTo);
    },
  };
}

/** Where the value starting at `at` ends, or -1 when there is none to mask. */
function readValue(
  text: string,
  at: number,
  literalValuesOnly: boolean,
  header: boolean,
): number {
  const first = text[at];
  if (first === undefined) {
    return -1;
  }

  let end: number;
  if (first === "\\" && (text[at + 1] === '"' || text[at + 1] === "'")) {
    end = readEscapedQuoted(text, at);
  } else if (first === '"' || first === "'" || first === "`") {
    end = readQuoted(text, at, literalValuesOnly);
  } else if (literalValuesOnly) {
    return -1;
  } else if (header) {
    end = runUntil(text, at, HEADER_VALUE_END);
    return end === at ? -1 : end;
  } else if (first === "{" || first === "[") {
    end = readBracketed(text, at);
  } else {
    end = runUntil(text, at, BARE_VALUE_END);
    if (end === at || text[end - 1] === ":") {
      // Nothing, or the next pair's key: `currentPassword: newPassword: x`.
      return -1;
    }
    if (SCHEME_WORD.test(text.slice(at, end)) && /[ \t]/.test(text[end])) {
      // `token: Bearer eyJ...` - the credential, not just its scheme.
      const credential = skipBlanks(text, end);
      const credentialEnd = runUntil(text, credential, /\s/);
      return credentialEnd > credential ? credentialEnd : end;
    }
    return end;
  }

  if (literalValuesOnly) {
    return end;
  }
  // A quoted name rather than a value: `"currentPassword": "newPassword": x`.
  const after = skipBlanks(text, end);
  if (
    text[after] === ":" &&
    end < text.length &&
    first !== "{" &&
    first !== "["
  ) {
    return -1;
  }
  // Text run on behind a closing quote or bracket is the value's too:
  // `token=[abc]def`.
  while (end < text.length && /\w/.test(text[end])) {
    end++;
  }
  return end;
}

function runUntil(text: string, at: number, stop: RegExp): number {
  let end = at;
  while (end < text.length && !stop.test(text[end])) {
    end++;
  }
  return end;
}

function skipBlanks(text: string, at: number): number {
  let end = at;
  while (text[end] === " " || text[end] === "\t") {
    end++;
  }
  return end;
}

/**
 * A quoted value through its closing quote, past the quotes it escapes. One
 * that is not closed on its line - a message cut short - runs to the end of
 * the line (a template literal in source, to the end of the text): what it
 * held is masked rather than the head of it kept.
 */
function readQuoted(text: string, at: number, inSource = false): number {
  const quote = text[at];
  const spansLines = inSource && quote === "`";
  for (let i = at + 1; i < text.length; i++) {
    const char = text[i];
    if (char === "\\") {
      i++;
    } else if (char === quote) {
      return i + 1;
    } else if (char === "\n" && !spansLines) {
      return i;
    }
  }
  return text.length;
}

/**
 * A value quoted with escaped quotes - `\"x\"`, JSON inside a JSON string -
 * through its closing `\"`. Inside it, a quote of its own is `\\\"`; a quote
 * behind an even run of backslashes is the enclosing string's, and ends the
 * value before it.
 */
function readEscapedQuoted(text: string, at: number): number {
  const quote = text[at + 1];
  for (let i = at + 2; i < text.length; i++) {
    if (text[i] === "\n") {
      return i;
    }
    if (text[i] !== "\\") {
      continue;
    }
    let runEnd = i;
    while (runEnd < text.length && text[runEnd] === "\\") {
      runEnd++;
    }
    const run = runEnd - i;
    if (text[runEnd] === quote) {
      if (run % 2 === 0) {
        return runEnd;
      }
      if (run % 4 === 1) {
        return runEnd + 1;
      }
    }
    i = runEnd - 1;
  }
  return text.length;
}

/**
 * An object or array through the bracket that closes it, its strings read as
 * strings. One never closed runs to the end of the text.
 */
function readBracketed(text: string, at: number): number {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const char = text[i];
    if (char === "{" || char === "[") {
      depth++;
    } else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    } else if (char === '"') {
      i = readQuoted(text, i) - 1;
    } else if (char === "\\") {
      i++;
    }
  }
  return text.length;
}

function buildDefaultRules(
  isSensitiveKey: SensitiveKeyMatcher,
  checkEveryKey: boolean,
  literalValuesOnly = false,
): CompiledRule[] {
  return [
    // PEM blocks first: they span lines and would otherwise be partially eaten
    // by the narrower rules below.
    { scan: scanPemBlocks },
    // Card numbers before any key: a key's bare value stops at a space, so
    // `token: 4000 0566 5566 5556` would lose only its first group.
    { scan: scanCardNumbers },
    // Authorization schemes: `Bearer eyJ...`, `Basic dXNlcjpwYXNz`.
    //
    // Must precede the key=value rule. That rule's value stops at whitespace, so
    // on `Authorization: Basic dXNlcjpwYXNz` it would consume only the word
    // "Basic" and leave the credential itself sitting in the line. Not a word
    // followed by `:` - `Invalid Basic credentials: dXNl...` names a key, whose
    // value the key=value rule masks.
    {
      pattern:
        /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=%-]{8}[A-Za-z0-9._~+/=%-]*(?![A-Za-z0-9._~+/=%-]|[ \t]*:)/gi,
      replace: (replacement, scheme) => `${scheme} ${replacement}`,
    },
    // The scheme-prefixed form already masked above collapses here into one
    // `[REDACTED]` under an `Authorization` key, rather than two stacked.
    keyValueRule(isSensitiveKey, checkEveryKey, literalValuesOnly),
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
 *
 * Read as runs of digit groups, so a card beside other numbers - an expiry
 * date, a CVV, a timestamp in front - is still found: a card is one group of
 * 13-19 digits, or groups in a card's own layout (4-4-4-4 and its shorter and
 * longer forms, 4-6-5, 4-6-4). Only those windows are Luhn-checked, so the
 * odds of masking an ordinary run of numbers stay what they were.
 */
const DIGIT_RUN = /(?:\b|(?<=\\[nrtbf]))\d+(?:[ -]\d+)*/g;
const CARD_LAYOUTS = [
  [4, 4, 4, 4, 3],
  [4, 4, 4, 4, 2],
  [4, 4, 4, 4, 1],
  [4, 4, 4, 4],
  [4, 6, 5],
  [4, 6, 4],
  [4, 4, 4, 3],
  [4, 4, 4, 2],
  [4, 4, 4, 1],
];

function scanCardNumbers(text: string, mask: (secret: string) => string) {
  let output = "";
  let copiedTo = 0;
  for (const run of text.matchAll(DIGIT_RUN)) {
    const runEnd = run.index + run[0].length;
    // A run that goes on into a word (`4111...abc`) is an identifier.
    const usable = /\w/.test(text[runEnd] ?? "")
      ? run[0].slice(0, Math.max(0, run[0].search(/[ -]\d+$/)))
      : run[0];
    if (usable.length < 13) {
      continue;
    }
    const groups: Array<[start: number, end: number]> = [];
    for (const group of usable.matchAll(/\d+/g)) {
      groups.push([
        run.index + group.index,
        run.index + group.index + group[0].length,
      ]);
    }
    for (let i = 0; i < groups.length; ) {
      const end = cardEndingAt(text, groups, i);
      if (end === undefined) {
        i++;
        continue;
      }
      output +=
        text.slice(copiedTo, groups[i][0]) +
        mask(text.slice(groups[i][0], groups[end][1]));
      copiedTo = groups[end][1];
      i = end + 1;
    }
  }
  return copiedTo === 0 ? text : output + text.slice(copiedTo);
}

/** The last group of a Luhn-valid card starting at group `first`, if any. */
function cardEndingAt(
  text: string,
  groups: Array<[number, number]>,
  first: number,
): number | undefined {
  const length = (i: number) => groups[i][1] - groups[i][0];
  const digitsOf = (from: number, to: number) => {
    let digits = "";
    for (let i = from; i <= to; i++) {
      digits += text.slice(groups[i][0], groups[i][1]);
    }
    return digits;
  };
  if (length(first) >= 13 && length(first) <= 19) {
    return isLuhnValid(digitsOf(first, first)) ? first : undefined;
  }
  for (const layout of CARD_LAYOUTS) {
    if (first + layout.length > groups.length) {
      continue;
    }
    if (layout.every((size, offset) => length(first + offset) === size)) {
      const last = first + layout.length - 1;
      if (isLuhnValid(digitsOf(first, last))) {
        return last;
      }
    }
  }
  return undefined;
}

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
    this.matchesSensitiveKey = createSensitiveKeyMatcher(options.keys);

    // Configured keys are matched exactly and can be anything, so the cheap
    // stem test in front of the matcher cannot stand in for them.
    const checkEveryKey = (options.keys ? [...options.keys].length : 0) > 0;
    const defaults =
      options.useDefaultPatterns === false
        ? []
        : buildDefaultRules(this.matchesSensitiveKey, checkEveryKey);
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
      ...(options.useDefaultPatterns === false
        ? []
        : buildDefaultRules(this.matchesSensitiveKey, checkEveryKey, true)),
      ...extra,
    ];
  }

  /**
   * Whether a key names a credential - the built-in rules plus the configured
   * `keys`. Exposed so a caller masking by key somewhere this class does not
   * reach (a URL's query string) is held to the same list.
   */
  isSensitiveKey(key: string): boolean {
    return this.matchesSensitiveKey(key);
  }

  /**
   * Colour codes are taken out first. The forwarder strips them off a raw
   * line, but a JSON logger writes the escape as `\u001b`, so they only come
   * back once the line is decoded - and between a key and its value, or in
   * front of a card number, they stop every rule matching.
   */
  redactMessage(message: string): string {
    return this.apply(
      message.includes("\x1b") ? stripAnsi(message) : message,
      this.rules,
      false,
    );
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
    if (typeof value === "number") {
      return this.isCardNumber(value) ? this.replacement : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, depth + 1));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          this.redactKey(key),
          // A sensitive key masks its value whatever the shape - an object under
          // `credentials` is exactly what must not be walked into and partially
          // preserved.
          this.matchesSensitiveKey(key.includes("\x1b") ? stripAnsi(key) : key)
            ? this.replacement
            : this.redactValue(item, depth + 1),
        ]),
      );
    }
    return value;
  }

  /**
   * A key is a name, but not always: a JSON body parsed as a form is one key
   * holding the whole document. Only a key long enough to hold a secret, or
   * holding a pair, is read - the rest are the ordinary names they look like.
   */
  private redactKey(key: string): string {
    return key.length > 12 || /[:=]/.test(key) ? this.redactMessage(key) : key;
  }

  /** A card number written as a JSON number: `{"number": 4111111111111111}`. */
  private isCardNumber(value: number): boolean {
    if (!this.redactCards || !Number.isInteger(value) || value < 1e12) {
      return false;
    }
    const digits = String(value);
    return digits.length <= 19 && /^\d+$/.test(digits) && isLuhnValid(digits);
  }
}
