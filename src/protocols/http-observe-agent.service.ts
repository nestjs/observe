import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  RequestMethod,
} from "@nestjs/common";
import {
  captureRequest,
  shouldCaptureRequest,
} from "../utils/capture-request.util.js";
import { HttpAdapterHost } from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { Subscription } from "rxjs";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { RequestSnapshot } from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS, TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import { redactUrlQuery } from "../utils/redact-url-query.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";

/**
 * How long an aborted request's handler gets to finish its spans before the
 * trace is dropped from the registry. Generous next to a typical handler, tiny
 * next to a leak that never frees.
 */
const ABORTED_TRACE_EVICTION_GRACE_MS = 30_000;

/** The adapter hooks requests are traced through, all added in Nest 11.1.4. */
const REQUEST_HOOKS = [
  "setOnRequestHook",
  "setOnResponseHook",
  "setOnRouteTriggered",
] as const;

/** What the request hook reads of an Express or Fastify request. */
interface IncomingHttpRequest {
  url: string;
  method: string;
  protocol: string;
  headers?: Record<string, string | string[] | undefined>;
}

@Injectable()
export class HttpObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HttpObserveAgentService.name);
  private warnedAboutHooks = false;
  private httpAdapterInitSubscription: Subscription | undefined;

  /**
   * `http.queryParamsObfuscateRegex`, rebuilt with the global flag when it was
   * supplied without one. It is applied with `replaceAll`, which throws on a
   * non-global RegExp - inside the request hook, so every traced request would
   * answer 500 while ignored routes (health checks) kept passing. Same
   * normalisation `RedactionOptions.patterns` already receives.
   */
  private readonly queryParamsObfuscateRegex: RegExp | undefined;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly traceSamplerService: TraceSamplerService,
  ) {
    this.queryParamsObfuscateRegex = toGlobalRegExp(
      this.options.http?.queryParamsObfuscateRegex,
    );

    // The "setOnRouteTriggered" hook must be set immediately
    // to ensure that route metadata is captured correctly.
    const { httpAdapter } = this.httpAdapterHost;
    if (!httpAdapter || !this.hasRequestHooks(httpAdapter)) {
      return;
    }

    httpAdapter.setOnRouteTriggered(
      (requestMethod: RequestMethod, path: string) => {
        const store = this.asyncLocalStorage.getStore();
        if (!store) {
          return;
        }
        const traceId =
          store.get(TRACE_REGISTRY_KEY as KeyOf<Store>) ??
          store.get(this.options.traceIdKey);
        if (!traceId) {
          return;
        }
        this.operationTraceRegistry.addRouteMetadataToTrace(
          traceId,
          requestMethod,
          path,
        );
      },
    );
  }

  onModuleInit() {
    this.httpAdapterInitSubscription = this.httpAdapterHost.init$?.subscribe(
      () => this.registerHttpHooks(),
    );
  }

  onModuleDestroy() {
    if (this.httpAdapterInitSubscription) {
      this.httpAdapterInitSubscription.unsubscribe();
    }
  }

  registerHttpHooks() {
    const { httpAdapter } = this.httpAdapterHost;
    if (!httpAdapter || !this.hasRequestHooks(httpAdapter)) {
      return;
    }

    httpAdapter.setOnRequestHook(
      (req: IncomingHttpRequest, res: unknown, done: () => void) => {
        this.startHttpRequestTracing(req, res, done);
      },
    );

    // Fastify waits for `done` before it runs the next onResponse hook.
    // Express does not pass one.
    httpAdapter.setOnResponseHook(
      (
        req: unknown,
        res: {
          statusCode: number;
        },
        done?: () => void,
      ) => {
        this.endHttpRequestTracing(req, res);
        done?.();
      },
    );
  }

  startHttpRequestTracing(
    req: IncomingHttpRequest,
    res: unknown,
    done: () => void,
  ) {
    // The same map `run` is given, rather than `getStore()` inside the callback:
    // identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    this.asyncLocalStorage.run(store, () => {
      const traceId = this.options.traceIdGenerator(req);
      store.set(this.options.traceIdKey, traceId);

      if (this.options.http?.setAttributes) {
        const attributes = this.options.http?.setAttributes?.(req);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      // A request that is not recorded still carries its trace id, which an
      // adopted `x-request-id` can share with a recorded request. A registry
      // key of its own, never registered, keeps its lookups off that trace.
      const skip = () => {
        store.set(TRACE_REGISTRY_KEY as KeyOf<Store>, uuidv7());
        done();
      };

      if (this.shouldIgnoreRequest(req) || this.isUntracedPreflight(req)) {
        return skip();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("http", {
        url: req.url,
        method: req.method,
      });
      if (!shouldCapture) {
        return skip();
      }
      // Sensitive query parameters are masked whether or not the deployment
      // configured anything: an opt-in redactor protects only those who
      // already knew to ask, and a reset token in a stored URL is the same
      // disclosure either way. A configured regex still applies, on top rather
      // than instead - it exists for the keys only that deployment knows
      // about.
      const redactedUrl = redactUrlQuery(
        req.url,
        this.operationTraceRegistry.getRedactor(),
      );
      const originalUrl = this.queryParamsObfuscateRegex
        ? redactedUrl.replaceAll(this.queryParamsObfuscateRegex, "[REDACTED]")
        : redactedUrl;

      // An adopted `x-request-id` is not unique to this request: a caller
      // that fans out, or retries, sends the same id twice, and both requests
      // can be open here at once. The second gets a registry key of its own -
      // only the second, so the ordinary request is still keyed by its id.
      let registryKey = traceId;
      if (this.operationTraceRegistry.hasTrace(traceId)) {
        registryKey = uuidv7();
        store.set(TRACE_REGISTRY_KEY as KeyOf<Store>, registryKey);
      }

      this.operationTraceRegistry.startTrace(
        registryKey,
        {
          protocol: req.protocol,
          tags: this.options.http?.tags,
          attributes: {
            method: req.method,
            originalUrl,
          },
        },
        traceId,
      );
      this.evictTraceOnClientAbort(res, registryKey);
      done();
    });
  }

  endHttpRequestTracing(req: unknown, res: { statusCode: number }): void {
    const store = this.asyncLocalStorage.getStore();
    if (!store) {
      return;
    }
    const traceId =
      store.get(TRACE_REGISTRY_KEY as KeyOf<Store>) ??
      store.get(this.options.traceIdKey);
    if (!traceId) {
      return;
    }
    setTimeout(async () => {
      let userId: string | undefined;
      if (this.options.http?.getUserId) {
        userId = this.options.http?.getUserId?.(req);
      }
      this.operationTraceRegistry.endTrace(traceId, {
        statusCode: res.statusCode,
        userId,
      });

      const snapshot = await this.operationTraceRegistry.pluckSnapshot(traceId);
      if (!snapshot) {
        return;
      }
      if (shouldCaptureRequest(snapshot, this.options.http?.capture)) {
        const captured = captureRequest(
          req,
          this.options.http?.capture,
          this.operationTraceRegistry.getRedactor(),
        );
        if (captured) {
          (snapshot as RequestSnapshot).request = captured;
        }
      }
      this.observeAgentSharedBuffer.insertRequestSnapshot(
        snapshot as RequestSnapshot,
      );
    }, 0);
  }

  /**
   * Frees the trace when the client goes away before the response finishes.
   *
   * The adapter's response hook rides `res.on("finish")`, and an aborted
   * request never emits it - the socket emits `close` instead. Without this,
   * every abort leaves its snapshot and span map in the registry for the life
   * of the process; on an ingest endpoint taking 16MB bodies over slow links,
   * aborts are routine, not exceptional.
   *
   * On the normal path `close` follows `finish` with `writableFinished`
   * already true, so this stays a no-op there - `endHttpRequestTracing` has
   * either plucked the trace or is about to.
   *
   * Eviction is deferred, not immediate: Express does not cancel the handler
   * on abort, so its spans are usually still closing when `close` fires, and
   * each one ending after the snapshot is gone would log an error. The grace
   * period lets the handler drain first; `unref` keeps the timer from holding
   * a shutting-down process open.
   */
  private evictTraceOnClientAbort(res: unknown, traceId: string): void {
    const response = res as {
      on?: (event: string, listener: () => void) => void;
      writableFinished?: boolean;
    };
    if (typeof response?.on !== "function") {
      return;
    }
    response.on("close", () => {
      if (response.writableFinished) {
        return;
      }
      const timer = setTimeout(
        () => this.operationTraceRegistry.abandonTrace(traceId),
        ABORTED_TRACE_EVICTION_GRACE_MS,
      );
      timer.unref?.();
    });
  }

  /**
   * Whether the adapter has the hooks requests are traced through, warning
   * the first time it does not.
   *
   * A missing framework hook is a no-op, never an error. Nest added all three
   * in 11.1.4, and this used to throw from the constructor when one was absent
   * - so an application on an earlier 11.x, inside the supported range, did
   * not start at all. Without the hooks there is no request to attach a trace
   * to, so the HTTP side stands aside and everything else is still reported.
   */
  private hasRequestHooks(httpAdapter: object): boolean {
    if (REQUEST_HOOKS.every((hook) => hook in httpAdapter)) {
      return true;
    }
    if (!this.warnedAboutHooks) {
      this.warnedAboutHooks = true;
      this.logger.warn(
        "HTTP requests will not be traced: this HTTP adapter has no request hooks, which Nest added in 11.1.4. Upgrade @nestjs/core and your @nestjs/platform-* package to trace them.",
      );
    }
    return false;
  }

  /**
   * A CORS preflight, when `http.tracePreflights` has not asked for them.
   *
   * Recognised by what the CORS spec defines a preflight to be - `OPTIONS`
   * with an `Access-Control-Request-Method` header - rather than by the
   * method alone, so an application's own `OPTIONS` handler is still traced.
   * Both adapters lower-case header names.
   */
  private isUntracedPreflight(req: IncomingHttpRequest): boolean {
    return (
      !this.options.http?.tracePreflights &&
      req.method === "OPTIONS" &&
      req.headers?.["access-control-request-method"] !== undefined
    );
  }

  private shouldIgnoreRequest(req: { url: string; method: string }): boolean {
    if (typeof this.options.http?.ignore === "function") {
      return this.options.http.ignore(req);
    }
    if (Array.isArray(this.options.http?.ignore)) {
      const blocklist = this.options.http.ignore;
      return blocklist.some((item) => {
        if (typeof item === "string") {
          return req.url === item;
        }
        if (item instanceof RegExp) {
          return item.test(req.url);
        }
        if (typeof item === "object") {
          return (
            item.method === req.method &&
            (typeof item.path === "string"
              ? req.url === item.path
              : item.path.test(req.url))
          );
        }

        return false;
      });
    }
    return false;
  }
}

/**
 * Rebuilds a RegExp with the global flag when it lacks one, keeping the
 * original otherwise. `replaceAll` refuses a non-global pattern outright.
 */
function toGlobalRegExp(pattern: RegExp | undefined): RegExp | undefined {
  if (!pattern || pattern.global) {
    return pattern;
  }
  return new RegExp(pattern.source, pattern.flags + "g");
}
