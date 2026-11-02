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
import {
  OBSERVE_OPTIONS,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import { redactUrlQuery } from "../utils/redact-url-query.js";
import { openTelemetryTraceIdGenerator } from "../utils/default-trace-id-generator.util.js";
import { usesDefaultTraceIdGenerator } from "../utils/trace-id-generator-origin.util.js";
import { inboundTraceContext } from "../utils/trace-context.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import {
  deferTraceCompletion,
  generateTraceIdSafely,
  getUserIdSafely,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";

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

/** What the request hook reads of an Express, Fastify or Node request. */
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
        const registryKey = store.get(TRACE_REGISTRY_KEY);
        if (typeof registryKey !== "string") {
          return;
        }
        this.operationTraceRegistry.addRouteMetadataToTrace(
          registryKey,
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
      // OpenTelemetry interop runs only while the collector takes this app's
      // telemetry - see `ObserveAgentSharedBuffer.isIngesting`. Asked once
      // per request, so a request is named and carried on one way throughout.
      const openTelemetry =
        this.options.openTelemetry === true &&
        this.observeAgentSharedBuffer.isIngesting();
      const traceId = generateTraceIdSafely(
        openTelemetry && usesDefaultTraceIdGenerator(this.options)
          ? openTelemetryTraceIdGenerator
          : this.options.traceIdGenerator,
        req,
        this.options,
        this.logger,
      );
      store.set(this.options.traceIdKey, traceId);

      // An adopted `x-request-id` is not unique to this request: a caller that
      // fans out, or retries, sends the same id twice. Claim this execution
      // before option callbacks can reach another request's trace. A request
      // that is not recorded keeps the key too, never registered, so its
      // lookups stay off a recorded request sharing its id.
      const registryKey = uuidv7();
      store.set(TRACE_REGISTRY_KEY, registryKey);

      // With OpenTelemetry interop on, read whatever produced the trace id: a
      // `traceIdGenerator` of the application's own decides what Observe
      // calls the trace, not which OpenTelemetry trace the caller is in, and
      // outbound calls carry that one on either way - for an unrecorded
      // request too, so the trace does not break here. An OpenTelemetry SDK
      // in this process has the say on which trace that is, when one runs -
      // see `inboundTraceContext`.
      if (openTelemetry) {
        const traceContext = inboundTraceContext(req.headers);
        if (traceContext) {
          store.set(TRACE_CONTEXT_KEY as KeyOf<Store>, traceContext);
        }
      }

      setAttributesSafely(
        this.options.http?.setAttributes,
        [req],
        this.options.http,
        store,
        this.logger,
        "http",
      );

      if (this.shouldIgnoreRequest(req) || this.isUntracedPreflight(req)) {
        return done();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("http", {
        url: req.url,
        method: req.method,
      });
      if (!shouldCapture) {
        return done();
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
    // Only this execution's own key: a stale store left by a finished request
    // must not complete a later one that reuses its id.
    const registryKey = store.get(TRACE_REGISTRY_KEY);
    if (
      typeof registryKey !== "string" ||
      !this.operationTraceRegistry.hasTrace(registryKey)
    ) {
      return;
    }
    deferTraceCompletion(
      async () => {
        const userId = getUserIdSafely(
          this.options.http?.getUserId,
          [req],
          this.options.http,
          this.logger,
          "http",
        );
        this.operationTraceRegistry.endTrace(registryKey, {
          statusCode: res.statusCode,
          userId,
        });

        const snapshot =
          await this.operationTraceRegistry.pluckSnapshot(registryKey);
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
      },
      this.logger,
      "http",
      () => this.operationTraceRegistry.hasOpenSpans(registryKey),
    );
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
   * on abort, so its spans are usually still closing when `close` fires. The
   * grace period lets the handler drain first; `unref` keeps the timer from
   * holding a shutting-down process open.
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
   * Every adapter lower-cases header names.
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
      return shouldIgnoreSafely(
        this.options.http.ignore,
        [req],
        this.options.http,
        this.logger,
        "http",
      );
    }
    if (Array.isArray(this.options.http?.ignore)) {
      const blocklist = this.options.http.ignore;
      return blocklist.some((item) => {
        if (typeof item === "string") {
          return req.url === item;
        }
        if (item instanceof RegExp) {
          return testIgnoreRegex(item, req.url);
        }
        if (typeof item === "object") {
          return (
            item.method === req.method &&
            (typeof item.path === "string"
              ? req.url === item.path
              : testIgnoreRegex(item.path, req.url))
          );
        }

        return false;
      });
    }
    return false;
  }
}

/**
 * Global and sticky regular expressions carry a lastIndex between calls. Use
 * a fresh expression for each ignore decision so matching always starts at the
 * beginning without changing the user's regex state. Ordinary expressions
 * are stateless here and can be tested directly.
 */
function testIgnoreRegex(pattern: RegExp, value: string): boolean {
  if (!pattern.global && !pattern.sticky) {
    return pattern.test(value);
  }
  return new RegExp(pattern.source, pattern.flags).test(value);
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
