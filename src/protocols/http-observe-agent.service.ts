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
import { redactUrlQuery, toGlobalRegExp } from "../utils/redact-url-query.js";
import { openTelemetryTraceIdGenerator } from "../utils/default-trace-id-generator.util.js";
import { usesDefaultTraceIdGenerator } from "../utils/trace-id-generator-origin.util.js";
import { inboundTraceContext } from "../utils/trace-context.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import { setAgentHook, shareHookSlot } from "../utils/shared-hook-slot.util.js";
import {
  deferTraceCompletion,
  generateTraceIdSafely,
  getUserIdSafely,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";
import {
  endOperation,
  OperationState,
  openOperation,
} from "../utils/operation-state.util.js";

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

type RequestHook = (
  req: any,
  res: any,
  done: (err?: Error) => unknown,
) => unknown;
type ResponseHook = (req: any, res: any, done?: () => void) => unknown;
type RouteTriggeredHook = (requestMethod: RequestMethod, path: string) => void;

/**
 * Takes the adapter's request and response hooks over as soon as there is an
 * adapter, so that hooks the application sets on it from then on run beside
 * the agent's rather than in their place: from a provider, from `main.ts`
 * before `listen()`. They have no getter, so a hook set on the adapter before
 * it reached Nest cannot be found, and stays the agent's to replace. Called
 * from the instance decorator, the moment Nest creates the `HttpAdapterHost`,
 * and again from the agent, for an application without the decorator. On
 * `init$` rather than the adapter itself: `@nestjs/testing` attaches the
 * adapter only once the testing module is compiled.
 */
export function shareHttpAdapterHooks(
  httpAdapterHost: Pick<HttpAdapterHost, "httpAdapter" | "init$">,
): void {
  const share = () => {
    try {
      const { httpAdapter } = httpAdapterHost;
      if (httpAdapter) {
        shareHookSlot(httpAdapter, "setOnRequestHook");
        shareHookSlot(httpAdapter, "setOnResponseHook");
      }
    } catch {
      // An adapter that cannot be read is one there is nothing to share on.
    }
  };
  try {
    httpAdapterHost.init$?.subscribe(share);
  } catch {
    // Run from the instance decorator, which Nest 11 does not guard.
  }
}

@Injectable()
export class HttpObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(HttpObserveAgentService.name);
  private warnedAboutHooks = false;
  private httpAdapterInitSubscription: Subscription | undefined;

  /**
   * The registry key each request was started under, by the request object -
   * which every adapter hands to both of its hooks. The response hook cannot
   * ask the async store: it runs from `finish`, in the async context of
   * whatever ended the response, and that need not be the request's own. A
   * request pipelined behind another has its `finish` emitted from the
   * earlier one's; a stream piped into the response ends it where its source
   * emits - for a pooled database connection, in the request that opened it.
   */
  private readonly registryKeys = new WeakMap<object, string>();

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

    shareHttpAdapterHooks(this.httpAdapterHost);

    // The "setOnRouteTriggered" hook must be set immediately
    // to ensure that route metadata is captured correctly.
    const { httpAdapter } = this.httpAdapterHost;
    if (!httpAdapter || !this.hasRequestHooks(httpAdapter)) {
      return;
    }

    // Beside the application's, one set before (found through the getter,
    // which Nest's router reads the hook from too, and is left to it) or
    // after.
    setAgentHook<RouteTriggeredHook>(
      httpAdapter,
      "setOnRouteTriggered",
      (requestMethod, path) => {
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
      composeRouteTriggered,
      { getter: "getOnRouteTriggered" },
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

    // Set beside the application's hooks, which `shareHttpAdapterHooks` has
    // made the slots keep.
    setAgentHook<RequestHook>(
      httpAdapter,
      "setOnRequestHook",
      (req: IncomingHttpRequest, res, done) =>
        this.startHttpRequestTracing(req, res, done),
      composeRequestHook,
    );
    setAgentHook<ResponseHook>(
      httpAdapter,
      "setOnResponseHook",
      (req, res: { statusCode: number }) =>
        this.endHttpRequestTracing(req, res),
      composeResponseHook,
    );
  }

  /**
   * Opens the request's trace and calls `done` inside its store, handing back
   * what `done` returns: an application's request hook runs inside it, and
   * the adapter waits on or fails the request by what that hook returns.
   */
  startHttpRequestTracing(
    req: IncomingHttpRequest,
    res: unknown,
    done: () => unknown,
  ): unknown {
    // The same map `run` is given, rather than `getStore()` inside the callback:
    // identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      // OpenTelemetry interop runs only beside reporting to NestJS Observe -
      // see `ObserveAgentSharedBuffer.isReporting`. Asked once per request,
      // so a request is named and carried on one way throughout.
      const openTelemetry =
        this.options.openTelemetry === true &&
        this.observeAgentSharedBuffer.isReporting();
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
      this.registryKeys.set(req, registryKey);
      // Ended when the response closes, recorded or not, answered or
      // aborted: see `liveTraceId`.
      this.watchResponseClose(res, openOperation(store), registryKey);

      // With OpenTelemetry interop on, read whatever produced the trace id: a
      // `traceIdGenerator` of the application's own decides what Observe
      // calls the trace, not which OpenTelemetry trace the caller is in, and
      // outbound calls carry that one on either way - for an unrecorded
      // request too, so the trace does not break here. An OpenTelemetry SDK
      // in this process has the say on which trace that is, when one runs -
      // see `inboundTraceContext`. The registry keeps it beside the
      // snapshot too, for `otlp`, which puts the operation's span under it.
      const traceContext = openTelemetry
        ? inboundTraceContext(req.headers)
        : undefined;
      if (traceContext) {
        store.set(TRACE_CONTEXT_KEY as KeyOf<Store>, traceContext);
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
      const originalUrl = redactUrlQuery(
        req.url,
        this.operationTraceRegistry.getRedactor(),
        this.queryParamsObfuscateRegex,
      );

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
        traceContext,
      );
      // Answered by the CORS layer before any route, and on Fastify before
      // any middleware too: a preflight asked for has no span to keep it.
      if (isPreflight(req)) {
        this.operationTraceRegistry.keepWithoutSpans(registryKey);
      }
      return done();
    });
  }

  endHttpRequestTracing(req: unknown, res: { statusCode: number }): void {
    // This request's own key, never the one in the async store: the store
    // here is that of whatever ended the response, a finished request's or
    // another one still running, and neither may be completed in this one's
    // place, nor leave this one open.
    const registryKey =
      typeof req === "object" && req !== null
        ? this.registryKeys.get(req)
        : undefined;
    if (
      registryKey === undefined ||
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
            this.queryParamsObfuscateRegex,
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
   * Ends the request's operation when its response closes - answered or
   * aborted, recorded or not - and frees the trace when the client went away
   * before the response finished.
   *
   * The adapter's response hook rides `res.on("finish")`, and an aborted
   * request never emits it - the socket emits `close` instead. Without this,
   * every abort leaves its snapshot and span map in the registry for the life
   * of the process; on an ingest endpoint taking 16MB bodies over slow links,
   * aborts are routine, not exceptional.
   *
   * Express and the Node adapter hand the request hook the Node response
   * itself; Fastify hands it the reply, which is no emitter, with the Node
   * response under it as `raw`.
   *
   * On the normal path `close` follows `finish` with `writableFinished`
   * already true, so the trace is left alone there - `endHttpRequestTracing`
   * has either plucked it or is about to. A response that does not say is
   * left alone too.
   *
   * Dropped at once, not after a grace period: an abandoned trace is never
   * reported, and the registry already lets a handler that outlives its
   * client end its spans on a trace that is gone. Held for 30 s, it was the
   * client's to say how many such traces the process kept.
   */
  private watchResponseClose(
    res: unknown,
    operation: OperationState,
    traceId: string,
  ): void {
    const given = res as { on?: unknown; raw?: unknown } | undefined;
    const response = (typeof given?.on === "function" ? given : given?.raw) as
      | {
          on?: (event: string, listener: () => void) => void;
          writableFinished?: boolean;
        }
      | undefined;
    if (typeof response?.on !== "function") {
      return;
    }
    response.on("close", () => {
      endOperation(operation);
      // A request that was never recorded has nothing registered to drop.
      if (response.writableFinished === false) {
        this.operationTraceRegistry.abandonTrace(traceId);
      }
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

  /** A CORS preflight, when `http.tracePreflights` has not asked for them. */
  private isUntracedPreflight(req: IncomingHttpRequest): boolean {
    return !this.options.http?.tracePreflights && isPreflight(req);
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
          return matchesPath(item, req.url);
        }
        if (item instanceof RegExp) {
          return testIgnoreRegex(item, req.url);
        }
        if (typeof item === "object") {
          return (
            item.method === req.method &&
            (typeof item.path === "string"
              ? matchesPath(item.path, req.url)
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
 * The request hook the adapter is given: the agent's outside, and the
 * application's inside the agent's `done`, so it runs in the request's store
 * - its log lines and calls carry the trace - and whatever it returns, a
 * promise the adapter fails the request by, goes back to the adapter. It
 * refuses a request with `done(err)`, by throwing or by answering it itself,
 * as without the agent; the response hook still closes the trace.
 */
function composeRequestHook(
  application: RequestHook | undefined,
  agent: RequestHook,
): RequestHook {
  if (!application) {
    return agent;
  }
  return function (this: unknown, req, res, done) {
    return agent.call(this, req, res, () =>
      application.call(this, req, res, done),
    );
  };
}

/**
 * The response hook the adapter is given: the agent's first, whatever the
 * application's does, then the application's, handed `done` - Fastify waits
 * for it before its next `onResponse` hook, Express passes none - and
 * returning what it returns.
 */
function composeResponseHook(
  application: ResponseHook | undefined,
  agent: ResponseHook,
): ResponseHook {
  return function (this: unknown, req, res, done) {
    if (!application) {
      agent.call(this, req, res);
      return done?.();
    }
    let returned: unknown;
    try {
      agent.call(this, req, res);
    } finally {
      returned = application.call(this, req, res, done);
    }
    return returned;
  };
}

/**
 * How deep composed route hooks are running. The getter Nest's router reads
 * the hook from hands an application the composed hook, and one chaining
 * "the previous hook" calls it from inside the next composed one: there only
 * the hook it wraps runs, as the agent's part already has.
 */
let routeTriggeredDepth = 0;

/** The route hook the adapter is given: the agent's part, then the application's. */
function composeRouteTriggered(
  application: RouteTriggeredHook | undefined,
  agent: RouteTriggeredHook,
): RouteTriggeredHook {
  return function (this: unknown, requestMethod, path) {
    if (routeTriggeredDepth > 0) {
      return application?.call(this, requestMethod, path);
    }
    routeTriggeredDepth++;
    try {
      agent.call(this, requestMethod, path);
      return application?.call(this, requestMethod, path);
    } finally {
      routeTriggeredDepth--;
    }
  };
}

/**
 * Whether a string entry of `http.ignore` names this request: the URL itself,
 * or its path - the URL up to a `?` or `#`. `req.url` carries the query string
 * on every adapter, so compared whole, an endpoint that takes its input there
 * was never ignored, and `/health` was traced whenever a caller added one. An
 * entry written with a query string still matches that URL exactly. Read in
 * place, without cutting the URL, as this runs for every request.
 */
function matchesPath(literal: string, url: string): boolean {
  if (url === literal) {
    return true;
  }
  const next = url[literal.length];
  return (
    (next === "?" || next === "#") &&
    url.startsWith(literal) &&
    !literal.includes("?") &&
    !literal.includes("#")
  );
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
 * A CORS preflight: what the CORS spec defines one to be - `OPTIONS` with an
 * `Access-Control-Request-Method` header - rather than the method alone, so
 * an application's own `OPTIONS` handler is still traced as a request. Every
 * adapter lower-cases header names.
 */
function isPreflight(req: IncomingHttpRequest): boolean {
  return (
    req.method === "OPTIONS" &&
    req.headers?.["access-control-request-method"] !== undefined
  );
}
