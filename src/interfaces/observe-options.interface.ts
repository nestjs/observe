import type { OutgoingHttpOptions } from "../outgoing/http.integration.js";
import type { HttpCaptureOptions } from "../utils/capture-request.util.js";
import {
  FactoryProvider,
  ModuleMetadata,
  Provider,
  Type,
} from "@nestjs/common";
import { BaseRpcContext, Transport } from "@nestjs/microservices";
import { GraphQLResolveInfoLike } from "./graphql.interfaces.js";

export interface RedactionOptions {
  /**
   * Whether to scrub log lines at all.
   * @default true
   */
  enabled?: boolean;

  /**
   * Extra patterns to mask, for credentials shaped in a way only your codebase
   * knows about - internal token prefixes, customer identifiers, and so on.
   *
   * Patterns are applied with the global flag whether or not you set it, so a
   * pattern cannot silently mask just the first occurrence in a line.
   */
  patterns?: RegExp[];

  /**
   * Extra keys whose values are masked outright, on top of the built-in
   * rules - wherever masking is by key: log attributes, captured headers and
   * bodies, and the query string of a recorded URL. Compared
   * case-insensitively, ignoring `-` and `_`, so "apiKey", "api_key" and
   * "API-KEY" are one entry.
   *
   * The built-in rules already match a name by what it ends in (`resetToken`,
   * `client_secret`, `X-Amz-Signature`), so this is for names that do not say
   * what they hold.
   */
  keys?: string[];

  /**
   * Text substituted for anything redacted.
   * @default '[REDACTED]'
   */
  replacement?: string;

  /**
   * Whether to apply the built-in patterns - bearer tokens, JWTs, AWS key ids,
   * PEM private keys, `key=value` secrets and Luhn-valid card numbers.
   *
   * Disable only if you are replacing them wholesale with `patterns`; there is
   * no supported configuration in which forwarding logs unredacted is a good
   * idea, and this switch exists for tuning, not for opting out.
   * @default true
   */
  useDefaultPatterns?: boolean;
}

export interface CreateObserveModuleOptions {
  /**
   * The trace ID key used to identify the trace in the context.
   * This key is used to store the trace ID in the context for later retrieval.
   * If not provided, the default key 'traceId' will be used.
   * @default 'traceId'
   */
  traceIdKey?: string;

  /**
   * A function to generate a trace ID for each request.
   * This function should return a unique string that will be used as the trace ID.
   * If not provided, a default trace ID generator will be used.
   * For HTTP protocols, the request object is passed to the function.
   * For non-HTTP protocols, the request object will be contextual and may not be available.
   * The default implementation uses the 'x-request-id' header if available,
   * or mints a time-ordered UUID (version 7) if the header is not present -
   * an id the collector can locate in time without a scan.
   * @default (req) => req.headers['x-request-id'] || uuidv7()
   */
  traceIdGenerator?: (req: unknown) => string;

  /**
   * Whether to augment the ConsoleLogger to include the trace ID in log messages.
   * If true, the trace ID will be included in the log messages by default.
   * This is useful for correlating logs with traces.
   * @default true
   */
  attachTraceIdToLogs?: boolean;

  /**
   * Excludes providers from instrumentation. Return true for an instance that
   * should stay untouched - no proxy is placed around it and none of its
   * methods produce spans.
   *
   * Runs before the built-in checks, so it also shields providers that
   * cannot even be inspected safely: some libraries (nestjs-cls proxy
   * providers, for instance) register proxies that throw on any property
   * access outside their own context. Those are skipped automatically when
   * inspection throws, but this hook lets you exclude them - or anything
   * else - explicitly.
   * @example (instance) => instance instanceof MyUninstrumentableService
   * @default () => false
   */
  skipInstrumentation?: (instance: unknown) => boolean;

  /**
   * Attaches the source around each in-app stack frame to captured errors, so the
   * throw site can be shown with its code rather than just a file and line.
   *
   * Only the machine running the code can read its own files, which is why this is
   * captured here rather than resolved server-side.
   *
   * Note that enabling this ships fragments of your source to the Observe server,
   * where they are stored alongside the error. Frames inside `node_modules` and
   * Node internals are never read, but application source is - turn this off if
   * that is not acceptable for your codebase.
   *
   * @default true
   */
  sourceContext?:
    | boolean
    | {
        /**
         * Lines to read either side of the frame's line.
         * @default 5
         */
        linesOfContext?: number;
        /**
         * How many in-app frames to attach source for, counted from the top of
         * the stack. Bounds the payload on deep stacks.
         * @default 5
         */
        maxFrames?: number;
        /**
         * Resolves compiled frames back through source maps before reading source.
         *
         * Only needed when the process runs compiled output without Node's own
         * source map support - without it, frames point at `dist/*.js` and the
         * captured source would be compiled JavaScript. With Node started under
         * `--enable-source-maps` (or `process.setSourceMapsEnabled(true)`) stack
         * frames already carry original positions and this is redundant work.
         *
         * Costs a map parse per compiled file on first touch, cached thereafter.
         *
         * @default false
         */
        sourceMaps?: boolean;
      };
}

export interface ObserveOptions {
  /**
   * Application key identifying this service to the collector.
   *
   * Sign up at https://observe.nestjs.com and create a service; the dashboard
   * issues the key and secret together.
   *
   * Sent as `x-api-key` on every ingest request, alongside `appSecret`.
   * Without valid credentials the collector answers 401 and the batch is
   * dropped.
   */
  appKey: string;

  /**
   * Secret paired with `appKey`, issued with it at https://observe.nestjs.com.
   *
   * Sent as `x-api-secret`. Shown once when the key is issued and not
   * retrievable afterwards, so treat it as you would a password: supply it from
   * the environment rather than committing it alongside the rest of this config.
   * If it is lost, issue a new pair from the dashboard.
   */
  appSecret: string;

  /**
   * Base URL of the collector, without a trailing path.
   *
   * One setting for telemetry and profiles both, so the two can never point at
   * different places. Defaults to the hosted collector; set `OBSERVE_ENDPOINT`
   * in the environment to override that without touching this config, which is
   * how a self-hosted or local collector is usually pointed at.
   *
   * @default 'https://observe-api.nestjs.com'
   */
  endpoint?: string;

  /**
   * Unique identifier for the service.
   * If you anticipate running multiple instances of the same service,
   * consider using a unique identifier such as a hostname or container ID.
   * This helps in distinguishing between different instances of the service in the APM.
   */
  serviceId: string;

  /**
   * Version of the service.
   * This can be used to track changes in the service over time.
   * It is optional and can be used to differentiate between different versions of the service.
   * For example, it could be a semantic version like "1.0.0"
   * or a commit hash like "abc123".
   */
  serviceVersion?: string;

  /**
   * Interval in milliseconds at which the tracer submits traces to the Agent.
   * The default value is 5000 milliseconds (5 seconds).
   * @default 5000
   */
  flushInterval?: number;

  /**
   * Whether to collect runtime metrics: memory, CPU load, GC and event loop
   * latency, sampled on an interval and drawn as gauges.
   *
   * Answers *whether* a process was struggling. `profiling` below answers
   * *which code* it was running - a different signal with a different cost.
   * @default true
   */
  runtimeMetrics?: boolean;

  /**
   * Interval in milliseconds at which runtime metrics are collected and sent to
   * the Agent. Only applicable when `runtimeMetrics` is enabled.
   * @default 60000
   */
  runtimeMetricsInterval?: number;

  /**
   * Continuous profiling: a sampling CPU profiler whose stacks are tagged with
   * the span that was executing, so a slow span can be opened as a flame graph.
   *
   * SHELVED - setting this currently does nothing. The agent does not start the
   * sampler and the collector's /profiles endpoints are unregistered. Kept,
   * along with its implementation and tests, for a later return.
   *
   * Off unless a block is supplied, and off by default inside it. Profiling
   * samples on the profiled thread - V8 profiles the isolate the session is
   * attached to, so it cannot be moved onto the agent's worker - and no agent
   * should start doing that to a customer's process because they upgraded.
   *
   * Built on `node:inspector` rather than a native profiler: a native addon
   * would land in the install of every service using this agent, including the
   * overwhelming majority that never switch this on.
   */
  // profiling?: {
  //   /** @default false */
  //   enabled?: boolean;

  //   /**
  //    * Samples per second. 99 rather than 100 to avoid lockstep with the 10ms
  //    * timers `setInterval` lands on.
  //    * @default 99
  //    */
  //   sampleRateHz?: number;

  //   /**
  //    * Wall clock one upload window covers.
  //    * @default 60000
  //    */
  //   windowMs?: number;

  //   /**
  //    * How much of each window is actually sampled. Duty cycling is what makes
  //    * continuous profiling affordable; the backend records the rate and the
  //    * coverage per window, so a sparsely sampled window is a complete answer
  //    * rather than a gap.
  //    * @default 10000
  //    */
  //   dutyMs?: number;

  //   /**
  //    * Share of one core the profiler may cost before it stops sampling for the
  //    * life of the process.
  //    * @default 3
  //    */
  //   maxCpuPercent?: number;
  // };

  /**
   * The sample rate for traces, which determines the percentage of traces that are sent to the Agent.
   * A value of 1.0 means all traces are sent, while a value of 0.1 means 10% of traces are sent.
   * @default 1.0
   */
  tracesSampleRate?:
    | number
    | ((
        protocal: "http" | "rpc" | "grpc" | "graphql" | "ws",
        attributes: any,
      ) => boolean);

  /**
   * Maximum number of traces per batch that can be sent to the Agent.
   * This is useful for controlling the volume of traces sent, especially in high-traffic applications.
   * @default 1000
   */
  maxTracesPerBatch?: number;

  /**
   * Collapses repeated sibling spans before a trace is shipped.
   *
   * A provider the framework calls in a loop - the canonical case is a
   * `ValidationPipe` registered through `APP_PIPE`, which runs once per
   * argument of every GraphQL field resolver - produces thousands of
   * near-identical spans under one parent for a single list query. Every one
   * of them is a metered event, and together they say nothing a count would
   * not.
   *
   * When more than `threshold` siblings under the same parent share a class
   * and method, the slowest `keepSlowest` of them and any that errored stay
   * as ordinary spans, and the rest are replaced by a single node carrying
   * their count (as the `observe.collapsed` tag) and their *summed*
   * duration. That sum is what keeps the parent's self time exact, and the
   * children of the collapsed calls are carried across so class attribution
   * beneath them survives too. The collapsed node is metered as one event.
   *
   * Nothing is skipped and no duration threshold is involved, deliberately:
   * what validation costs is application-specific, and the outliers that
   * explain a slow request are exactly the instances kept whole. What is lost
   * is the relative ordering of the collapsed calls among themselves - the
   * node takes the earliest call's `startOffset` - which is acceptable for
   * calls that are identical by construction.
   *
   * On by default. Set to `false` to ship every span.
   *
   * @default { threshold: 20, keepSlowest: 3 }
   */
  spanCollapse?:
    | false
    | {
        /**
         * Number of siblings sharing a class and method that a parent may
         * hold before the surplus is collapsed. Collapsing starts at
         * `threshold + 1`.
         * @default 20
         */
        threshold?: number;
        /**
         * How many of the slowest instances to keep as individual spans when
         * a group collapses. Errored instances are kept in addition to these.
         * @default 3
         */
        keepSlowest?: number;
      };

  /**
   * Whether to forward logs to the Observe APM.
   * If true, logs will be forwarded to the Agent for correlation with traces.
   * @default false
   */
  forwardLogs?: boolean;

  /**
   * How log lines and error payloads are scrubbed before leaving the process.
   *
   * Applies to forwarded log lines (when `forwardLogs` is enabled) and to the
   * message and stack of every error attached to a trace - a database error
   * quoting its connection string, a failed request quoting a URL with a token
   * in it. Both move text onto someone else's disk, and secrets reach them by
   * accident far more often than by design, so the safe behaviour is the one
   * you get without asking. Set `enabled: false` to turn it off deliberately.
   */
  redaction?: RedactionOptions;

  /**
   * Whether to enable debug mode for the Observe APM.
   * If true, additional debug information will be logged to the console.
   * This is useful for development and troubleshooting purposes.
   * @default false
   */
  debug?: boolean;

  /**
   * HTTP configuration options for the Observe APM.
   */
  http?: {
    /**
     * A list of HTTP endpoints to ignore for tracing.
     */
    ignore?:
      | Array<string | { method: string; path: string | RegExp } | RegExp>
      | ((req: any) => boolean);
    /**
     * Tags to be added to all HTTP requests.
     * These tags can be used to provide additional context for the requests.
     * @example { 'environment': 'production', 'version': '1.0.0' }
     * @default {}
     */
    tags?: Record<string, string>;
    /**
     * A function to generate additional attributes for HTTP requests.
     * This function receives the request object and should return an object containing key-value pairs.
     * These attributes can be retrieved later within the trace.
     * @example (req) => ({ 'user-agent': req.headers['user-agent'], 'client-ip': req.ip })
     * @default (req) => ({})
     */
    setAttributes?: (req: any) => {
      [key: string]: string | number | boolean;
    };
    /**
     * A regular expression to obfuscate query parameters in HTTP requests.
     * This is useful for masking sensitive information in query strings.
     *
     * Applied *in addition to* the built-in redaction, which always masks the
     * values of well-known sensitive parameters (`token`, `password`, `code`,
     * `signature`, ...) whether or not this is set. Use it for the parameters
     * only your application knows are sensitive.
     * @default undefined
     */
    queryParamsObfuscateRegex?: RegExp;
    /**
     * What to record of the request itself - the inputs that tell a
     * reproducible problem from a one-off - for a request that **failed**, or
     * one slower than `slowerThanMs` when that is set. Never recorded for an
     * ordinary request.
     *
     * By default a short allow-list of headers that neither authenticate nor
     * identify the caller (`user-agent`, `content-type`, `referer`, ...) and
     * no body. Everything recorded passes through `redaction` first. Set to
     * `false` to record nothing.
     * @example { headers: ['user-agent', 'x-tenant-id'], body: { maxBytes: 4096 }, slowerThanMs: 2000 }
     */
    capture?: HttpCaptureOptions | false;
    /**
     * A function to associate a user identifier with the HTTP request.
     * This function receives the request object and should return a string representing the user ID.
     * If not provided, no user ID will be associated with the request.
     * @example (req) => req.user?.id || 'anonymous'
     * @default undefined
     */
    getUserId?: (req: any) => string;
  };
  /**
   * RPC configuration options for the Observe APM.
   */
  rpc?: {
    /**
     * A function that determines whether to ignore a given RPC request.
     * This function receives the request context and should return true if the request should be ignored.
     */
    ignore?: (transportId: Transport | symbol, ctx: BaseRpcContext) => boolean;
    /**
     * Tags to be added to all RPC requests.
     * These tags can be used to provide additional context for the requests.
     * @example { 'environment': 'production', 'version': '1.0.0' }
     * @default {}
     */
    tags?: Record<string, string>;
    /**
     * A function to generate additional attributes for RPC requests.
     * This function receives the request context and should return an object containing key-value pairs.
     * These attributes can be retrieved later within the trace.
     * @example (ctx) => ({ 'service': ctx.getService(), 'method': ctx.getMethod() })
     * @default (ctx) => ({})
     */
    setAttributes?: (
      transportId: Transport | symbol,
      ctx: BaseRpcContext,
    ) => {
      [key: string]: string | number | boolean;
    };
    /**
     * A function to associate a user identifier with the HTTP request.
     * This function receives the request object and should return a string representing the user ID.
     * If not provided, no user ID will be associated with the request.
     * @example (transportId, ctx) => ctx.getMetadata().userId || 'anonymous'
     * @default undefined
     */
    getUserId?: (
      transportId: Transport | symbol,
      ctx: BaseRpcContext,
    ) => string;
  };
  /**
   * GraphQL configuration options for the Observe APM.
   *
   * A GraphQL server is usually an HTTP endpoint, so its requests are already
   * subject to the `http` options above - `http.ignore` drops the request
   * before the GraphQL layer sees it. These options tune what happens *inside*
   * a request that was let through: which operations get a span, and what that
   * span's trace is labelled with.
   *
   * The unit here is one GraphQL operation, not one resolver. Every hook below
   * is called once per operation, with an info object describing it: the
   * operation type as `parentType.name`, and the document's first root field as
   * `fieldName` - the same pair the operation id is built from.
   */
  graphql?: {
    /**
     * A function that determines whether to skip tracing a given operation.
     * Receives the GraphQL resolve info, so it can match on the operation type
     * ("Query", "Mutation", "Subscription") and the field name.
     *
     * Matching on a field name skips the whole operation the field leads, not
     * just that field: an operation is measured end to end, so it is traced or
     * it is not.
     * @example (info) => info.fieldName === 'healthcheck'
     */
    ignore?: (info: GraphQLResolveInfoLike) => boolean;
    /**
     * Tags to be added to traces started by, or labelled from, a GraphQL
     * operation.
     * @example { 'environment': 'production', 'version': '1.0.0' }
     * @default {}
     */
    tags?: Record<string, string>;
    /**
     * A function to generate additional attributes for GraphQL operations.
     * Receives the resolve info and the GraphQL context, and should return an
     * object containing key-value pairs. These attributes can be retrieved
     * later within the trace. Called once, before the operation is processed.
     * @example (info) => ({ 'operation': info.operation?.operation })
     * @default undefined
     */
    setAttributes?: (
      info: GraphQLResolveInfoLike,
      context: any,
    ) => {
      [key: string]: string | number | boolean;
    };
    /**
     * A function to associate a user identifier with the operation.
     *
     * Only consulted for operations that are *not* already inside an HTTP
     * trace - a query over HTTP takes its user id from `http.getUserId`, which
     * sees the whole request. This covers the transports that have no such
     * hook, subscriptions over a websocket in particular.
     * @example (context) => context.req?.user?.id
     * @default undefined
     */
    getUserId?: (context: any) => string;
  };
  /**
   * gRPC configuration options for the Observe APM.
   * This is used to configure the gRPC protocol tracing.
   */
  grpc?: {
    /**
     * A function that determines whether to ignore a given gRPC request.
     * This function receives the gRPC call object and should return true if the request should be ignored.
     */
    ignore?: (call: any) => boolean;
    /**
     * Tags to be added to all gRPC requests.
     * These tags can be used to provide additional context for the requests.
     * @example { 'environment': 'production', 'version': '1.0.0' }
     * @default {}
     */
    tags?: Record<string, string>;
    /**
     * A function to generate additional attributes for gRPC requests.
     * This function receives the gRPC call object and should return an object containing key-value pairs.
     * These attributes can be retrieved later within the trace.
     * @example (call) => ({ 'service': call.service, 'method': call.method })
     * @default (call) => ({})
     * */
    setAttributes?: (call: any) => {
      [key: string]: string | number | boolean;
    };
    /**
     * A function to associate a user identifier with the HTTP request.
     * This function receives the request object and should return a string representing the user ID.
     * If not provided, no user ID will be associated with the request.
     * @example (call) => call.metadata.userId || 'anonymous'
     * @default undefined
     */
    getUserId?: (call: any) => string;
  };
  /**
   * Spans for what leaves the process: database queries (`pg`, `mysql2`,
   * `mongodb` - and so every ORM built on them) and outbound HTTP requests
   * (`fetch`/undici and `node:http`, so axios too). On by default; `false`
   * switches all of it off.
   *
   * A query span is named after its verb and table (`SELECT users`) and
   * carries the statement with every literal removed; bound parameters are
   * never read. An HTTP span is named after the method and host, and carries
   * the URL with sensitive query parameters masked.
   */
  outgoing?:
    | false
    | {
        /** @default true */
        database?: boolean;
        /** @default true */
        http?: boolean | OutgoingHttpOptions;
      };
  /**
   * WebSocket gateway configuration options for the Observe APM.
   *
   * The unit is one inbound message handled by a `@SubscribeMessage()`
   * method, reported as a request whose operation id is
   * `GatewayClass:pattern`. Connection and disconnection are not operations
   * and are not reported. A message has no carrier for a trace id, so each one
   * opens a trace of its own.
   */
  ws?: {
    /**
     * A function that determines whether to skip tracing a given message.
     * @example (message) => message.pattern === 'ping'
     * @default () => false
     */
    ignore?: (message: WsMessageContext) => boolean;
    /**
     * Tags to be added to every gateway message trace.
     * @default {}
     */
    tags?: Record<string, string | number | boolean>;
    /**
     * A function to generate additional attributes for a message. These can be
     * retrieved later within the trace.
     * @default () => ({})
     */
    setAttributes?: (message: WsMessageContext) => {
      [key: string]: string | number | boolean;
    };
    /**
     * A function to associate a user identifier with the message - typically
     * read from whatever the connection handler attached to the client.
     * @example (message) => message.client.data?.userId
     * @default undefined
     */
    getUserId?: (message: WsMessageContext) => string | undefined;
  };
  /**
   * Jobs configuration options for the Observe APM.
   *
   * Covers every handler reported as a job: BullMQ processors, and the
   * `@Cron`, `@Interval` and `@Timeout` handlers of `@nestjs/schedule`. For a
   * scheduled handler the scheduler type (`cron`, `interval`, `timeout`)
   * stands in for `queueName`, the decorator's `name` option - or
   * `ClassName.methodName` when none was given - for `name`, and every firing
   * gets a fresh `id`.
   */
  jobs?: {
    /**
     * Tags to be added to all job requests.
     * These tags can be used to provide additional context for the requests.
     * @example { 'environment': 'production', 'version': '1.0.0' }
     * @default {}
     */
    tags?: Record<string, string>;
    /**
     * A function to generate additional attributes for job processing.
     * This function receives the job object and should return an object containing key-value pairs.
     * These attributes can be retrieved later within the trace.
     * @example (job) => ({ 'queueName': job.queueName, 'jobName': job.name })
     * @default (job) => ({})
     */
    setAttributes?: (job: {
      /** The BullMQ queue, or the scheduler type for a scheduled handler. */
      queueName: string;
      name: string;
      /**
       * Absent until the queue driver has assigned one. Always present for a
       * scheduled handler, where it identifies this particular firing.
       */
      id: string | undefined;
    }) => {
      [key: string]: string | number | boolean;
    };
  };
}

export type ObserveModuleOptionsWithDefaults =
  Required<CreateObserveModuleOptions> & ObserveOptions;

/**
 * Implemented by the class passed to `ObserveModule.forRootAsync()` as
 * `useClass` or `useExisting`.
 */
export interface ObserveOptionsFactory {
  createObserveOptions(): Promise<ObserveOptions> | ObserveOptions;
}

export interface ObserveModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  useExisting?: Type<ObserveOptionsFactory>;
  useClass?: Type<ObserveOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<ObserveOptions> | ObserveOptions;
  inject?: FactoryProvider["inject"];
  /**
   * Extra providers to be registered
   */
  extraProviders?: Provider[];
  /**
   * Set to true to register ObserveModule as a global module
   */
  global?: boolean;
}

/** What a `ws` option hook is told about the message being handled. */
export interface WsMessageContext {
  /** Class name of the gateway handling the message. */
  gateway: string;
  /** The `@SubscribeMessage()` pattern. */
  pattern: string;
  /** The client socket, as the platform adapter hands it to the gateway. */
  client: any;
  /** The message payload. Never recorded - it is here for the hooks only. */
  data: unknown;
}
