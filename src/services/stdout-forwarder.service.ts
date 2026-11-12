import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { REQUEST_ID_PATTERN } from "../utils/default-trace-id-generator.util.js";
import { fitToLength } from "../utils/fit-to-length.util.js";
import {
  ParsedLogLine,
  parseLogLine,
  stripAnsi,
} from "../utils/log-line.parser.js";
import { LogRedactor } from "../utils/log-redactor.js";
import {
  CALLER_METADATA_KEY,
  OBSERVE_OPTIONS,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";

/**
 * Cap on the unterminated tail held between writes.
 *
 * A process that writes a long stretch without a newline (a progress bar, a
 * streamed response) would otherwise grow this string without bound. At the cap
 * the tail is forwarded rather than discarded - a partial line is still
 * evidence - and the rest of that line, up to its newline, is dropped: it is
 * not a line of its own, and a secret the cap split would start it. A line
 * written in one call loses everything past the 4 KB the shared buffer keeps
 * of an entry anyway.
 */
const MAX_PARTIAL_LINE_LENGTH = 8 * 1024;

/**
 * Most text the redactor is ever given in one go - a line, or a message and
 * the lines under it. Text past it is not sent: see `REDACTION_LOOKAHEAD`.
 *
 * Everything in `toLogEntries` runs synchronously inside the patched
 * `process.stdout.write`, on the application's own hot path, and the redactor
 * is a set of regular expressions whose cost grows with input length. A single
 * multi-megabyte line - a dumped payload, and payloads can carry content an
 * outside caller chose - must not be able to hold the event loop while every
 * rule walks it. A bound only helps while that cost stays linear: a pattern
 * that backtracks super-linearly holds the loop for minutes inside 16 KB, which
 * is why the redactor's patterns are written to be linear.
 *
 * The parser is not held to it. It is linear, and a line cut before it reads
 * it is a different line: a JSON record no longer parses, and goes out as raw
 * text that nothing masks by key.
 */
const MAX_REDACTED_LENGTH = 16 * 1024;

/**
 * How much of what the redactor is shown is there only to be seen, past the
 * text that is sent.
 *
 * A cut through a secret leaves two pieces no rule recognises, and the piece
 * in front of the cut ships: masking shortens the text before it - a long
 * `token=AAAA…` becomes `token=[REDACTED]` - so the edge of a 16 KB window can
 * land inside the 4 KB the shared buffer keeps of an entry. So text that has
 * to be cut is redacted twice, cut and with this much more of it, and only
 * what the two agree on is sent: a secret the cut splits is whole, and
 * masked, in the longer text, and the two part where it starts. A secret
 * longer than this that a cut splits can still leave its start behind.
 */
const REDACTION_LOOKAHEAD = 4 * 1024;

/**
 * Longest `context` the collector accepts. It does not cut a longer one down:
 * it refuses the whole batch the line rides in, traces and metrics included.
 */
const MAX_CONTEXT_LENGTH = 255;

/**
 * Most entries one write may add to the log buffer.
 *
 * The buffer's caps are shared by the whole process and keep what came first,
 * so a single logged value full of line breaks - a client's username, a
 * posted object `util.inspect` prints a property per line - would otherwise
 * become thousands of entries, push every other request's lines out of the
 * batch, and hold the event loop while each one was parsed and redacted.
 * Past this many, the opening lines are kept and one more entry says how many
 * followed.
 */
const MAX_ENTRIES_PER_WRITE = 50;

/**
 * Most unfinished lines held per stream, one for each execution that has
 * written one. An execution that ends without writing its newline leaves its
 * line behind, so past this many the one written to longest ago is forwarded
 * as it is.
 */
const MAX_HELD_LINES = 64;

const FORWARDED_STREAMS = ["stdout", "stderr"] as const;
type ForwardedStream = (typeof FORWARDED_STREAMS)[number];

type Store = Map<string, any>;

type LogEntry = Parameters<ObserveAgentSharedBuffer["pushLogs"]>[0][number];

/** The start of a line one execution is writing, and what it was written in. */
interface HeldLine {
  text: string;
  /** The async store of the last piece, which the line is filed under. */
  store: Store | undefined;
  /**
   * Set once the line was forwarded at the cap: what follows, up to its
   * newline, is the rest of it, and is dropped - see `MAX_PARTIAL_LINE_LENGTH`.
   */
  overflowed: boolean;
}

@Injectable()
export class StdoutForwarderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StdoutForwarderService.name);

  /**
   * Output arrives in chunks, not lines: a single write can carry half a line,
   * several lines, or a line split across two calls. Parsing a chunk directly
   * would mangle every log that straddles a boundary, so the trailing fragment
   * is held here until its newline shows up.
   *
   * One fragment per stream: stdout and stderr interleave freely, and joining
   * the tail of one onto the head of the other would fuse two unrelated lines.
   *
   * And one per execution, for the same reason: while one request prints a
   * reply piece by piece, others log. Joined, the pieces written so far went
   * out under the trace of whoever logged next, in front of a line that no
   * longer parsed, and a secret still being written was cut in two before it
   * was redacted. Keyed by the trace, as the registry is, rather than by the
   * store, which is copied for every span. Writes outside any execution share
   * the `undefined` key. Kept in the order the lines were last written to.
   */
  private readonly partialLines: Record<
    ForwardedStream,
    Map<unknown, HeldLine>
  > = {
    stdout: new Map(),
    stderr: new Map(),
  };
  private originalWrites: Record<
    ForwardedStream,
    typeof process.stdout.write
  > | null = null;

  /**
   * Null only when redaction has been switched off explicitly. Defaulting to on
   * matters more here than anywhere else in the agent: enabling `forwardLogs`
   * moves every log line onto another machine, and the failure mode of getting
   * it wrong is a credential in someone else's database.
   */
  private readonly redactor: LogRedactor | null;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly als: AsyncLocalStorage<Map<string, any>>,
  ) {
    this.redactor =
      this.options.redaction?.enabled === false
        ? null
        : new LogRedactor(this.options.redaction);

    if (this.options.forwardLogs && this.options.enabled !== false) {
      this.start();
    }
  }

  onModuleInit() {
    if (this.options.debug && this.options.forwardLogs) {
      this.logger.debug(
        "Forwarding log lines written to stdout and stderr to Observe.",
      );
    }
  }

  /**
   * Stops forwarding at the first close phase - before in-flight requests
   * finish and before the final flush. Lines written after this point, a
   * draining request's included, are not sent; its snapshot still is. Moving
   * this later needs care: forwarding during the final flush would feed the
   * agent's own "could not reach the collector" lines back into the batches
   * it is trying to send.
   */
  onModuleDestroy() {
    this.restore();
  }

  /**
   * Patches both stdout and stderr. Nest's `ConsoleLogger` writes `error` to
   * stderr and every other level to stdout, so a stdout-only patch forwarded
   * warnings and fatals but never a single error - including the line the
   * exceptions handler writes for every unhandled exception.
   */
  start() {
    if (this.originalWrites) {
      return;
    }

    // The unbound originals are kept, so `restore` puts back exactly what was
    // there. Storing the bound copy instead meant every start/restore cycle
    // left one more `bind` wrapper on the stream - and this module is designed
    // to be torn down and recreated.
    this.originalWrites = {
      stdout: process.stdout.write,
      stderr: process.stderr.write,
    };
    for (const name of FORWARDED_STREAMS) {
      this.patch(name);
    }
  }

  private patch(name: ForwardedStream) {
    const stream = process[name];
    const originalWrite = stream.write.bind(stream);

    stream.write = ((
      chunk: string | Uint8Array,
      encoding?: BufferEncoding,
      callback?: (err?: Error | null) => void,
    ) => {
      if (typeof chunk === "string") {
        // Never let a forwarding failure take down the write it wrapped -
        // the stream has to keep working even if telemetry does not.
        try {
          this.consume(chunk, name);
        } catch {
          // Intentionally silent: logging here would re-enter this same patched
          // write and recurse.
        }
      }
      return originalWrite(chunk, encoding as BufferEncoding, callback);
    }) as any;
  }

  /**
   * Restores the original stdout and stderr writes.
   *
   * Without this the patch outlives the module - which matters in tests, where
   * a torn-down app would keep pushing into a buffer nobody drains, and in any
   * process that recreates the Nest application.
   */
  private restore() {
    if (!this.originalWrites) {
      return;
    }
    for (const name of FORWARDED_STREAMS) {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const writer of this.partialLines[name].keys()) {
        this.flushPartial(name, writer);
      }
      process[name].write = this.originalWrites[name];
    }
    this.originalWrites = null;
  }

  private consume(chunk: string, name: ForwardedStream = "stdout") {
    const store: Store | undefined = this.als.getStore();
    const writer: unknown =
      store?.get(TRACE_REGISTRY_KEY) ?? store?.get(this.options.traceIdKey);
    const held = this.partialLines[name];
    const heldLine = held.get(writer);
    let combined = chunk;
    if (heldLine !== undefined) {
      // Set again below rather than updated in place, so the map stays in
      // the order the lines were last written to.
      held.delete(writer);
      if (heldLine.overflowed) {
        const newline = chunk.indexOf("\n");
        if (newline === -1) {
          held.set(writer, heldLine);
          return;
        }
        combined = chunk.slice(newline + 1);
      } else {
        combined = heldLine.text + chunk;
      }
    }
    const segments = combined.split("\n");

    // The final segment has no newline yet, so it is either an incomplete line
    // or the empty string left by a chunk that ended cleanly.
    const tail = segments.pop() ?? "";

    const entries = this.toLogEntries(
      segments.filter((line) => line.trim().length > 0),
      store,
    );
    if (tail.length > MAX_PARTIAL_LINE_LENGTH) {
      if (tail.trim().length > 0) {
        entries.push(...this.toLogEntries([tail], store, true));
      }
      held.set(writer, { text: "", store, overflowed: true });
    } else if (tail.length > 0) {
      held.set(writer, { text: tail, store, overflowed: false });
    }

    if (entries.length > 0) {
      this.observeAgentSharedBuffer.pushLogs(entries);
    }

    if (held.size > MAX_HELD_LINES) {
      this.flushPartial(name, held.keys().next().value);
    }
  }

  /** Forwards, as it is, the line one execution left unfinished. */
  private flushPartial(name: ForwardedStream, writer: unknown) {
    const line = this.partialLines[name].get(writer);
    this.partialLines[name].delete(writer);
    if (line === undefined || line.text.trim().length === 0) {
      return;
    }
    this.observeAgentSharedBuffer.pushLogs(
      this.toLogEntries([line.text], line.store),
    );
  }

  /**
   * The entries for the complete lines of one write - an entry per line, but
   * with the lines of one message redacted as the one text they were written
   * as.
   *
   * A logger hands over a message in a single write however many lines it
   * runs to, and only the first carries its prefix: the rest - the stack
   * under an error, a key in its PEM layout, a value that holds a line break -
   * arrive plain. Redacted a line at a time, such a secret is never seen
   * whole. So a line is redacted together with the plain lines under it; a
   * line with a prefix of its own starts another message, and a JSON record
   * is always a message by itself. A masked value takes its line breaks with
   * it, so a message can come back as fewer entries than it had lines.
   *
   * At most `MAX_ENTRIES_PER_WRITE` lines are read, and the lines past them
   * are shown to the redactor with the last message, so a secret the cut
   * splits is not half-sent. `store` is the one the lines were written in.
   * `unfinished` for a line that goes on past what was written of it - see
   * `MAX_PARTIAL_LINE_LENGTH`.
   */
  private toLogEntries(
    lines: string[],
    store: Store | undefined,
    unfinished = false,
  ): LogEntry[] {
    // Cut before anything is parsed or redacted, which is where the time
    // goes.
    const read =
      lines.length > MAX_ENTRIES_PER_WRITE
        ? MAX_ENTRIES_PER_WRITE - 1
        : lines.length;
    const messages: Array<{
      head: ParsedLogLine;
      lines: string[];
      longest: number;
    }> = [];
    for (let index = 0; index < read; index += 1) {
      const line = lines[index];
      // Parsed whole: see `MAX_REDACTED_LENGTH`.
      const parsed = parseLogLine(line);
      const message = messages.at(-1);
      if (
        message !== undefined &&
        message.head.format !== "json" &&
        parsed.format === "plain"
      ) {
        message.lines.push(parsed.message);
        message.longest = Math.max(message.longest, line.length);
      } else {
        messages.push({
          head: parsed,
          lines: [parsed.message],
          longest: line.length,
        });
      }
    }

    const entries: LogEntry[] = [];
    for (const [index, message] of messages.entries()) {
      const { head } = message;
      let text = message.lines.join("\n");
      let keep = text.length;
      if (index === messages.length - 1 && head.format !== "json") {
        if (read < lines.length) {
          text += this.linesAfter(lines, read);
        } else if (unfinished) {
          keep -= REDACTION_LOOKAHEAD;
        }
      }
      const redacted = this.redact(text, keep);
      const texts = head.format === "json" ? [redacted] : redacted.split("\n");
      for (const [at, part] of texts.entries()) {
        entries.push(
          // The lines under the first had no prefix of their own.
          at === 0
            ? this.toLogEntry(part, store, head, message.longest)
            : this.toLogEntry(part, store),
        );
      }
    }
    if (read < lines.length) {
      entries.push(
        this.toLogEntry(
          `[observe] ${lines.length - read} more lines of this write not forwarded`,
          store,
        ),
      );
    }
    return entries;
  }

  /**
   * The lines from `from` on, as the redactor is shown them past the last line
   * that is sent: each after a line break, and only as many as
   * `REDACTION_LOOKAHEAD` covers.
   */
  private linesAfter(lines: string[], from: number): string {
    let after = "";
    for (
      let index = from;
      index < lines.length && after.length < REDACTION_LOOKAHEAD;
      index += 1
    ) {
      after += "\n" + stripAnsi(lines[index]).trimEnd();
    }
    return after;
  }

  /**
   * `text` is redacted by now; `parsed` is the line it opens, when that line
   * said more than its text. `longest` is the longest line `text` was read
   * from: a line too long for the redactor's window goes without its
   * attributes, whose length only it bounds - every string in them would need
   * the window too.
   */
  private toLogEntry(
    text: string,
    store: Store | undefined,
    parsed?: ParsedLogLine,
    longest = 0,
  ): LogEntry {
    const contextTraceId = store?.get(this.options.traceIdKey);
    // The line's own trace id wins: it was captured when the log was written,
    // whereas the async store is read now and may already have moved on.
    //
    // Only an id shaped like one, though. It is read off text, and anyone who
    // gets a newline into a logged value can end a line with whatever
    // `Trace ID:` they like - so it is held to the rule a client-supplied
    // `x-request-id` is. An over-long one would get the whole batch refused.
    const lineTraceId =
      parsed?.traceId !== undefined && REQUEST_ID_PATTERN.test(parsed.traceId)
        ? parsed.traceId
        : undefined;
    const traceId = lineTraceId ?? contextTraceId;

    return {
      timestamp: Date.now(),
      traceId,
      // Only meaningful alongside the store's own trace. When the line carried a
      // trace id of its own and it disagrees, the store has moved on to a
      // different operation and its span belongs to that one - naming it here
      // would file the line under a span it was never written inside.
      spanId:
        traceId === contextTraceId
          ? store?.get(CALLER_METADATA_KEY)
          : undefined,
      level: parsed?.level,
      context:
        parsed?.context === undefined
          ? undefined
          : this.toContext(parsed.context),
      // Redaction happens before the entry reaches the shared buffer - which
      // is also before the buffer truncates oversized lines. That order is
      // deliberate: truncating first would cut a long secret in half and ship
      // the surviving half.
      attributes:
        parsed?.attributes === undefined || longest > MAX_REDACTED_LENGTH
          ? undefined
          : this.redactor
            ? this.redactor.redactAttributes(parsed.attributes)
            : parsed.attributes,
      text,
    };
  }

  /**
   * `text` redacted, and cut where it has to be: to its first `keep`
   * characters, and to what the redactor's window leaves room to send.
   *
   * Text that fits whole is redacted whole - the common case, one pass. Text
   * that has to be cut is redacted cut and with `REDACTION_LOOKAHEAD` more of
   * it, within the window, and only the prefix the two results share is sent:
   * a secret the cut splits is masked in the longer one, so the two part
   * before any of it.
   */
  private redact(text: string, keep: number = text.length): string {
    const shown =
      text.length > MAX_REDACTED_LENGTH
        ? text.slice(0, MAX_REDACTED_LENGTH)
        : text;
    const sent = Math.max(
      0,
      Math.min(
        keep,
        shown.length < text.length
          ? MAX_REDACTED_LENGTH - REDACTION_LOOKAHEAD
          : text.length,
      ),
    );
    if (!this.redactor) {
      return sent < text.length ? text.slice(0, sent) : text;
    }
    if (sent >= text.length) {
      return this.redactor.redactMessage(text);
    }
    return sharedPrefix(
      this.redactor.redactMessage(text.slice(0, sent)),
      this.redactor.redactMessage(shown),
    );
  }

  /**
   * A context is normally a class name, but it is read off the line like the
   * message, so it holds whatever was written there - a secret passed where a
   * context was expected (`logger.log("login", "token=" + token)`) included.
   * Redacted as the message is, and before the cut for the same reason, then
   * cut to what the collector accepts.
   */
  private toContext(context: string): string {
    return fitToLength(this.redact(context), MAX_CONTEXT_LENGTH);
  }
}

/**
 * The start `cut` and `whole` share, as a slice of `cut`. Never ends between
 * the two halves of a surrogate pair, which would send half a character.
 */
function sharedPrefix(cut: string, whole: string): string {
  const max = Math.min(cut.length, whole.length);
  let at = 0;
  while (at < max && cut.charCodeAt(at) === whole.charCodeAt(at)) {
    at += 1;
  }
  if (at > 0 && at < cut.length) {
    const last = cut.charCodeAt(at - 1);
    if (last >= 0xd800 && last <= 0xdbff) {
      at -= 1;
    }
  }
  return at === cut.length ? cut : cut.slice(0, at);
}
