/**
 * Turns a line of stdout into a structured log entry.
 *
 * Two shapes arrive here and neither can be assumed: a service running Nest's
 * JSON logger emits one object per line, while the default logger emits
 * formatted text - and plenty of lines are neither, because anything that writes
 * to stdout ends up in this path. Detection is therefore per line rather than
 * per service: a line that parses as a recognisable JSON log is treated as
 * structured, everything else falls back to text parsing, and a line that
 * matches nothing is still forwarded with its full text as the message.
 *
 * Nothing is ever dropped for being unparseable. A log the agent does not
 * understand is still the log the user is looking for.
 */

import type { LogLevel } from "@nestjs/common";

export interface ParsedLogLine {
  level?: LogLevel;
  context?: string;
  message: string;
  traceId?: string;
  attributes?: Record<string, unknown>;
  /**
   * What the line was read as: a record of a JSON logger, a line carrying
   * Nest's text prefix, or neither. A JSON record is always a whole message;
   * a `plain` line may be the rest of a message whose prefix was on the line
   * above it.
   */
  format: "json" | "nest" | "plain";
}
/**
 * CSI escape sequences - colour codes and cursor moves. Narrower than a
 * general-purpose ANSI stripper on purpose: this only has to undo what console
 * loggers emit, and a tight pattern cannot eat real log content.
 */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g;

/**
 * Nest's default ConsoleLogger line:
 *   [Nest] 1234  - 07/29/2026, 10:42:18 AM     LOG [AppController] message
 * The context bracket is optional - `logger.log()` without a context omits it.
 * The level is right-aligned in seven columns, so `VERBOSE` follows the
 * timestamp after a single space and every other level after several.
 *
 * Must stay linear in the length of the line: it runs on every line the
 * process writes, synchronously inside `process.stdout.write`, on text a caller
 * can shape. The pattern this replaced read `.+?\s{2,}` here - two quantifiers
 * that could both take the same run of whitespace - and backtracked cubically
 * on a `[Nest]` line that never reached a level: seconds for a few thousand
 * spaces. Here no two neighbouring quantifiers can take the same character.
 * The timestamp opens with a non-space, exactly one whitespace character
 * precedes the level, and nothing after the level can fail.
 */
const NEST_TEXT_PATTERN =
  /^\[Nest\]\s+\d+\s+-\s+\S.*?\s(FATAL|ERROR|WARN|LOG|DEBUG|VERBOSE)\s+(?:\[([^\]]+)\]\s*)?([\s\S]*)$/;

/**
 * Marker LoggerPatcherService puts before the trace id it appends when a trace
 * is in scope. Parsing the id back off recovers it even for lines whose async
 * context is gone by the time the forwarder sees them.
 */
const TRACE_ID_MARKER = "Trace ID:";

/** What may follow the marker: one token, and nothing after it. */
const TRACE_ID_VALUE_PATTERN = /^\s*(\S+)\s*$/;

/**
 * The levels the collector accepts, which are Nest's own. It refuses a batch
 * carrying any other value whole - every trace and metric in it lost over one
 * log line - so nothing else is ever put in `level`.
 */
const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>([
  "fatal",
  "error",
  "warn",
  "log",
  "debug",
  "verbose",
]);

/** Other loggers' names for a level the collector models. */
const LEVEL_ALIASES = new Map<string, LogLevel>([
  ["info", "log"],
  ["warning", "warn"],
  ["trace", "verbose"],
]);

/**
 * Keys the JSON logger sets that map onto modelled columns; anything else a
 * service attaches is preserved under `attributes`.
 */
const STRUCTURED_KEYS = new Set([
  "level",
  "message",
  "context",
  "traceId",
  "timestamp",
  "pid",
]);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function parseLogLine(line: string): ParsedLogLine {
  const clean = stripAnsi(line).trimEnd();

  return (
    parseStructured(clean) ??
    parseNestText(clean) ?? { message: clean, format: "plain" }
  );
}

function parseStructured(line: string): ParsedLogLine | null {
  // Cheap guard so the common text case never pays for a thrown parse error.
  if (!line.startsWith("{")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  // A JSON line with no message is some other program's output that happens to
  // be JSON - not a log we can model, so let the text path have it.
  if (typeof record.message !== "string") {
    return null;
  }

  const level = toLogLevel(record.level);
  const attributes = Object.fromEntries(
    Object.entries(record).filter(
      // A level the collector does not model - pino's numeric ones, a logger's
      // own `notice` - stays an attribute rather than being dropped.
      ([key]) =>
        !STRUCTURED_KEYS.has(key) || (key === "level" && level === undefined),
    ),
  );

  return {
    level,
    context: typeof record.context === "string" ? record.context : undefined,
    traceId: typeof record.traceId === "string" ? record.traceId : undefined,
    message: record.message,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    format: "json",
  };
}

function parseNestText(line: string): ParsedLogLine | null {
  const match = NEST_TEXT_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const [, level, context, rest] = match;
  const { message, traceId } = splitTraceIdSuffix(rest);

  return {
    level: toLogLevel(level),
    context: context || undefined,
    traceId,
    message,
    format: "nest",
  };
}

/**
 * Splits the trace id suffix off the end of a message, when there is one.
 *
 * Found with `lastIndexOf` rather than an unanchored `\s*Trace ID:...$`
 * pattern, which retried its leading `\s*` from every offset - quadratic in a
 * long run of whitespace, and that whitespace can come from a caller. Only the
 * last marker can be the suffix anyway: the marker itself contains a space, so
 * an earlier one is always followed by more than one token.
 */
function splitTraceIdSuffix(rest: string): {
  message: string;
  traceId?: string;
} {
  const markerIndex = rest.lastIndexOf(TRACE_ID_MARKER);
  if (markerIndex === -1) {
    return { message: rest };
  }

  const value = TRACE_ID_VALUE_PATTERN.exec(
    rest.slice(markerIndex + TRACE_ID_MARKER.length),
  );
  if (!value) {
    return { message: rest };
  }
  return { message: rest.slice(0, markerIndex).trimEnd(), traceId: value[1] };
}

function toLogLevel(value: unknown): LogLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const lower = value.toLowerCase();
  return LOG_LEVELS.has(lower) ? (lower as LogLevel) : LEVEL_ALIASES.get(lower);
}
