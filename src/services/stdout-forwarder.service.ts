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
import { parseLogLine } from "../utils/log-line.parser.js";
import { LogRedactor } from "../utils/log-redactor.js";
import { CALLER_METADATA_KEY, OBSERVE_OPTIONS } from "../observe.constants.js";

/**
 * Cap on the unterminated tail held between writes.
 *
 * A process that writes a long stretch without a newline (a progress bar, a
 * streamed response) would otherwise grow this string without bound. At the cap
 * the tail is forwarded as-is rather than discarded - a partial line is still
 * evidence.
 */
const MAX_PARTIAL_LINE_LENGTH = 8 * 1024;

/**
 * Most of a line the parser and redactor are ever given.
 *
 * Everything in `toLogEntry` runs synchronously inside the patched
 * `process.stdout.write`, on the application's own hot path, and the redactor
 * is a set of regular expressions whose cost grows with input length. A single
 * multi-megabyte line - a dumped payload, and payloads can carry content an
 * outside caller chose - must not be able to hold the event loop while every
 * rule walks it. A bound only helps while that cost stays linear: a pattern
 * that backtracks super-linearly holds the loop for minutes inside 16 KB, which
 * is why the parser's patterns are written to be linear.
 *
 * The bound is safe because it is four times what can ship: the shared buffer
 * truncates entries to 4 KB, so bytes beyond this window were never going to
 * leave the process - and a secret straddling the 4 KB cut still sits whole
 * inside this window, so it is redacted before the cut can split it.
 */
const MAX_PARSED_LINE_LENGTH = 16 * 1024;

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

const FORWARDED_STREAMS = ["stdout", "stderr"] as const;
type ForwardedStream = (typeof FORWARDED_STREAMS)[number];

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
   */
  private readonly partialLines: Record<ForwardedStream, string> = {
    stdout: "",
    stderr: "",
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
      this.flushPartial(name);
      process[name].write = this.originalWrites[name];
    }
    this.originalWrites = null;
  }

  private consume(chunk: string, name: ForwardedStream = "stdout") {
    const combined = this.partialLines[name] + chunk;
    const segments = combined.split("\n");

    // The final segment has no newline yet, so it is either an incomplete line
    // or the empty string left by a chunk that ended cleanly.
    this.partialLines[name] = segments.pop() ?? "";

    const lines = segments.filter((line) => line.trim().length > 0);
    if (lines.length > MAX_ENTRIES_PER_WRITE) {
      // Cut before anything is parsed or redacted, which is where the time
      // goes.
      const omitted = lines.length - (MAX_ENTRIES_PER_WRITE - 1);
      lines.length = MAX_ENTRIES_PER_WRITE - 1;
      lines.push(`[observe] ${omitted} more lines of this write not forwarded`);
    }
    const entries = lines.map((line) => this.toLogEntry(line));

    if (entries.length > 0) {
      this.observeAgentSharedBuffer.pushLogs(entries);
    }

    if (this.partialLines[name].length > MAX_PARTIAL_LINE_LENGTH) {
      this.flushPartial(name);
    }
  }

  private flushPartial(name: ForwardedStream) {
    const partialLine = this.partialLines[name];
    this.partialLines[name] = "";
    if (partialLine.trim().length === 0) {
      return;
    }
    this.observeAgentSharedBuffer.pushLogs([this.toLogEntry(partialLine)]);
  }

  private toLogEntry(rawLine: string) {
    const line =
      rawLine.length > MAX_PARSED_LINE_LENGTH
        ? rawLine.slice(0, MAX_PARSED_LINE_LENGTH)
        : rawLine;
    const parsed = parseLogLine(line);

    const store = this.als.getStore();
    const contextTraceId = store?.get(this.options.traceIdKey);
    // The line's own trace id wins: it was captured when the log was written,
    // whereas the async store is read now and may already have moved on.
    //
    // Only an id shaped like one, though. It is read off text, and anyone who
    // gets a newline into a logged value can end a line with whatever
    // `Trace ID:` they like - so it is held to the rule a client-supplied
    // `x-request-id` is. An over-long one would get the whole batch refused.
    const lineTraceId =
      parsed.traceId !== undefined && REQUEST_ID_PATTERN.test(parsed.traceId)
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
      level: parsed.level,
      context:
        parsed.context === undefined
          ? undefined
          : this.toContext(parsed.context),
      // Redaction happens here, before the entry reaches the shared buffer -
      // which is also before the buffer truncates oversized lines. That order is
      // deliberate: truncating first would cut a long secret in half and ship
      // the surviving half.
      attributes: this.redactor
        ? this.redactor.redactAttributes(parsed.attributes)
        : parsed.attributes,
      text: this.redactor
        ? this.redactor.redactMessage(parsed.message)
        : parsed.message,
    };
  }

  /**
   * A context is normally a class name, but it is read off the line like the
   * message, so it holds whatever was written there - a secret passed where a
   * context was expected (`logger.log("login", "token=" + token)`) included.
   * Redacted as the message is, and before the cut for the same reason, then
   * cut to what the collector accepts.
   */
  private toContext(context: string): string {
    const redacted = this.redactor
      ? this.redactor.redactMessage(context)
      : context;
    return fitToLength(redacted, MAX_CONTEXT_LENGTH);
  }
}
