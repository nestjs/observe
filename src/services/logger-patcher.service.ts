import {
  ConsoleLogger,
  Inject,
  Injectable,
  Logger,
  LogLevel,
  OnModuleInit,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { stripAnsi } from "../utils/log-line.parser.js";
import { liveTraceId } from "../utils/operation-state.util.js";

/** What precedes the trace id the text output ends its first line with. */
const TRACE_ID_MARKER = "Trace ID:";

/**
 * The stores, and the trace id keys read from each, that `ConsoleLogger` is
 * already patched for. Once per pair rather than once per patcher: every
 * application booted from the same module has a patcher of its own - a test
 * suite that boots two had every log line wrapped, and suffixed, twice - and
 * once per process would leave a second `createObserveModule()`, with a store
 * of its own, without ids.
 */
const patchedStores = new WeakMap<AsyncLocalStorage<any>, Set<string>>();

/**
 * Whether a line already ends with this trace's id, after the marker: the
 * suffix of another patch - a second copy of this package, say - or the
 * message's own last words. Read off the first line, without its colours,
 * the way the stdout forwarder reads it.
 */
function endsWithTraceId(line: string, traceId: string): boolean {
  return stripAnsi(line).trimEnd().endsWith(`${TRACE_ID_MARKER} ${traceId}`);
}

@Injectable()
export class LoggerPatcherService implements OnModuleInit {
  private readonly logger = new Logger(LoggerPatcherService.name);

  constructor(
    private readonly asyncLocalStorage: AsyncLocalStorage<any>,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
  ) {}

  onModuleInit() {
    this.injectTraceIdIntoLogs();
  }

  /**
   * Injects the trace ID into the logs if the `attachTraceIdToLogs` option is enabled.
   * This method modifies the ConsoleLogger's methods to include the trace ID in the log output.
   */
  injectTraceIdIntoLogs() {
    if (!this.options.attachTraceIdToLogs) {
      return;
    }

    const options = this.options;
    const asyncLocalStorage = this.asyncLocalStorage;
    const patchedKeys = patchedStores.get(asyncLocalStorage) ?? new Set();
    if (patchedKeys.has(options.traceIdKey)) {
      return;
    }
    const originalFormatMessage = ConsoleLogger.prototype["formatMessage"];
    const originalGetJsonLogObject =
      ConsoleLogger.prototype["getJsonLogObject"];

    if (!originalFormatMessage || !originalGetJsonLogObject) {
      this.logger.warn(
        'ConsoleLogger methods "formatMessage" or "getJsonLogObject" are not available, which means that you are likely using a version of NestJS that does not support these methods. Please, upgrade to at least NestJS 11.2.0. Skipping trace ID injection.',
      );
      return;
    }

    ConsoleLogger.prototype["getJsonLogObject"] = function (
      this: ConsoleLogger,
      // Nest calls this as `(message, options)`. The wrapper used to declare
      // `(logLevel, message, context)` and forward all three: the values still
      // landed correctly by accident - `message` in the first slot, the options
      // bag in the second - and the third argument was dropped on the floor.
      message: unknown,
      logOptions: {
        context: string;
        logLevel: LogLevel;
        writeStreamType?: "stdout" | "stderr";
        errorStack?: unknown;
      },
    ) {
      const requestId = liveTraceId(
        asyncLocalStorage.getStore(),
        options.traceIdKey,
      );
      const jsonLogObject = originalGetJsonLogObject.call(
        this,
        message,
        logOptions,
      );
      if (requestId) {
        // Not a field Nest models on the returned object, which is the whole
        // point of the patch.
        (jsonLogObject as Record<string, unknown>)["traceId"] = requestId;
      }
      return jsonLogObject;
    };

    ConsoleLogger.prototype["formatMessage"] = function (
      this: ConsoleLogger,
      // Everything Nest passes is forwarded untouched. Naming the parameters
      // once pinned this wrapper to one release's signature: Nest 12 added a
      // seventh (`params`), and a wrapper that forwarded six silently dropped
      // every structured param from text-mode output.
      ...args: Parameters<typeof originalFormatMessage>
    ) {
      const output: string = originalFormatMessage.apply(this, args);
      const requestId = liveTraceId(
        asyncLocalStorage.getStore(),
        options.traceIdKey,
      );
      if (!requestId) {
        return output;
      }
      // The suffix has to sit before the line's own newline. Appended after
      // it, the id lands on a line of its own - which the stdout forwarder
      // then ships as a separate, level-less entry, and the parser (which
      // reads the id off the end of the log line) never sees it.
      //
      // Before the first newline, not the last: a record can run to several
      // lines - an error is its message and then its stack - and only the
      // first carries the prefix the parser reads an id from. Put after the
      // stack, the id was on no line that is read, and the first line ended
      // with the error's message - whose own last words, `Trace ID: <id>`
      // from a client's value, then named the trace the line was filed under.
      const [logLevel] = args;
      const newline = output.indexOf("\n");
      const lineEnd =
        newline === -1
          ? output.length
          : output[newline - 1] === "\r"
            ? newline - 1
            : newline;
      // Once per line: a line that already names this trace there needs no
      // second suffix saying the same.
      if (endsWithTraceId(output.slice(0, lineEnd), requestId)) {
        return output;
      }
      const suffix = `   ${TRACE_ID_MARKER} ${this.colorize(requestId, logLevel)}`;
      return `${output.slice(0, lineEnd)}${suffix}${output.slice(lineEnd)}`;
    };

    patchedKeys.add(options.traceIdKey);
    patchedStores.set(asyncLocalStorage, patchedKeys);
  }
}
