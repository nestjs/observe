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

@Injectable()
export class LoggerPatcherService implements OnModuleInit {
  private readonly logger = new Logger(LoggerPatcherService.name);
  private readonly patchedWatermark = Symbol("observe:logger_patched");

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

    const isAlreadyPatched =
      Reflect.getOwnPropertyDescriptor(
        ConsoleLogger.prototype,
        this.patchedWatermark,
      )?.value === true;
    if (isAlreadyPatched) {
      return;
    }

    const options = this.options;
    const asyncLocalStorage = this.asyncLocalStorage;
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
      const store = asyncLocalStorage.getStore();
      const requestId = store?.get(options.traceIdKey);
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
      const store = asyncLocalStorage.getStore();
      const requestId = store?.get(options.traceIdKey);
      if (!requestId) {
        return output;
      }
      // The suffix has to sit before the line's own newline. Appended after
      // it, the id lands on a line of its own - which the stdout forwarder
      // then ships as a separate, level-less entry, and the parser (which
      // reads the id off the end of the log line) never sees it.
      const [logLevel] = args;
      const suffix = `   Trace ID: ${this.colorize(requestId, logLevel)}`;
      return output.endsWith("\n")
        ? `${output.slice(0, -1)}${suffix}\n`
        : `${output}${suffix}`;
    };

    // Add watermark to flag that the logger has been patched
    Reflect.defineProperty(ConsoleLogger.prototype, this.patchedWatermark, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}
