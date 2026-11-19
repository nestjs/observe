import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import type { BaseRpcContext, Server, Transport } from "@nestjs/microservices";
import { AsyncLocalStorage } from "async_hooks";
import { Subscription } from "rxjs";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { RequestSnapshot } from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import {
  OBSERVE_OPTIONS,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { readContextAccessor } from "../utils/context-accessor.util.js";
import { handedOnTraceContext } from "../utils/trace-context.util.js";
import { continueHandedOnTrace } from "../utils/trace-handoff.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import { setAgentHook } from "../utils/shared-hook-slot.util.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";
import {
  deferTraceCompletion,
  generateTraceIdSafely,
  getUserIdSafely,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";
import {
  endOperation,
  OPERATION_STATE_KEY,
  OperationState,
  openOperation,
} from "../utils/operation-state.util.js";

/**
 * The `@nestjs/microservices` surface this agent reads, loaded on demand so
 * the package stays an optional peer: the transport enum, and the context
 * classes the operation id is read from.
 */
type Microservices = Pick<
  typeof import("@nestjs/microservices"),
  | "Transport"
  | "KafkaContext"
  | "MqttContext"
  | "NatsContext"
  | "RedisContext"
  | "RmqContext"
  | "TcpContext"
  | "GrpcMethodStreamingType"
>;

interface GrpcCall<TRequest = any, TMetadata = any> {
  request: TRequest;
  metadata: TMetadata;
  operationId: string;
}

/**
 * A gRPC call as grpc-js hands it to the server's method: the request stream
 * itself, whose events the agent runs in the call's store.
 */
interface GrpcServerCall {
  metadata?: unknown;
  cancelled?: boolean;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once?: (event: string, listener: () => void) => unknown;
}

/** A call `rememberGrpcCalls` noted, and how its handler takes it. */
interface RememberedGrpcCall {
  call: GrpcServerCall;
  /**
   * Handed to a `@GrpcStreamCall` handler, which Nest waits on for good when
   * the call is cancelled - see `dropTraceOnCancel`.
   */
  streamCall: boolean;
}

/**
 * `ServerGrpc.createServiceMethod`, which builds the method grpc-js calls for
 * each call of a service - the same three parameters in every Nest release
 * the agent supports.
 */
type CreateServiceMethod = (
  methodHandler: unknown,
  protoNativeHandler: { requestStream?: boolean } | undefined,
  streamType: unknown,
) => unknown;

type ProcessingStartHook = (
  transportId: Transport | symbol,
  ctx: unknown,
  done: () => Promise<any>,
) => unknown;
type ProcessingEndHook = (
  transportId: Transport | symbol,
  ctx: unknown,
) => void;

@Injectable()
export class RpcObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleDestroy
{
  private readonly logger = new Logger(RpcObserveAgentService.name);
  private rpcTargetAddedSubscription: Subscription | undefined;
  /**
   * Assigned in the constructor. Every use below is reached only through the
   * hooks registered there, after a successful load - a service without the
   * package has no RPC target to hook.
   */
  private microservices: Microservices | undefined;

  /**
   * The registry key each operation was started under, by the context Nest
   * hands its end hook. That hook cannot ask the async store: Nest runs it
   * from the teardown of the handler's reply stream, in the async context of
   * whatever ended the stream - a TCP socket's `close`, a gRPC cancellation,
   * a subject another message's handler emitted into. As
   * `HttpObserveAgentService` keeps its keys by request.
   */
  private readonly registryKeys = new WeakMap<object, string>();

  /** The operation each context was started for - see `rememberOperation`. */
  private readonly operations = new WeakMap<object, OperationState>();

  /**
   * The gRPC calls of a request stream, by their metadata - see
   * `rememberGrpcCalls`.
   */
  private readonly grpcCalls = new WeakMap<object, RememberedGrpcCall>();

  /** The gRPC servers whose calls `rememberGrpcCalls` already notes. */
  private readonly grpcServers = new WeakSet<object>();

  constructor(
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly modulesContainer: ModulesContainer,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly traceSamplerService: TraceSamplerService,
  ) {
    // From the constructor, while Nest builds the providers: Nest announces
    // a server when it constructs the microservice around it, inside
    // `createMicroservice()` or `connectMicroservice()`, so the hooks are in
    // place before the application is handed the server and can set hooks
    // of its own on it (`getTransportServer()`), which then run beside them.
    this.microservices = this.loadMicroservices();
    if (!this.microservices) {
      return;
    }
    try {
      this.rpcTargetAddedSubscription = this.modulesContainer
        .getRpcTargetRegistry?.<Server>()
        .subscribe((target) => this.registerRpcHooks(target));
    } catch (error) {
      this.logger.warn(
        `RPC operations will not be instrumented: the microservice registry could not be subscribed to: ${describePeerLoadError(error)}`,
      );
    }
  }

  onModuleDestroy() {
    if (this.rpcTargetAddedSubscription) {
      this.rpcTargetAddedSubscription.unsubscribe();
    }
  }

  /**
   * Loads `@nestjs/microservices` without a static import, so a service that
   * exposes no microservice need not install the package. Loaded here rather
   * than lazily because the target registry is subscribed from the
   * constructor, and a dynamic `import()` would resolve after a target may
   * already have been announced.
   */
  private loadMicroservices(): Microservices | undefined {
    const result = loadOptionalPeer<Microservices>("@nestjs/microservices");
    if (!result.installed) {
      // No microservice means no RPC target to hook, and that is not a
      // misconfiguration.
      return undefined;
    }
    if (!result.module) {
      // Installed but unloadable is a misconfiguration, and the symptom
      // otherwise is a service whose RPC operations silently never appear.
      this.logger.warn(
        `@nestjs/microservices is installed but could not be loaded, so RPC operations will not be instrumented: ${describePeerLoadError(result.error)}`,
      );
      return undefined;
    }
    return result.module;
  }

  /**
   * Sets the agent's processing hooks on a server, beside any the application
   * sets on it - see `composeStartHook`.
   */
  registerRpcHooks(target: Server) {
    // Return `done()`'s promise, as Nest's default hook does. Nest's servers
    // hand it back from their message handlers: kafkajs waits on it to commit
    // the offset or retry the message, and recent Nest versions log its
    // rejection for most other transports.
    setAgentHook<ProcessingStartHook>(
      target,
      "setOnProcessingStartHook",
      (transportId, ctx, done) => {
        if (transportId === this.microservices!.Transport.GRPC) {
          return this.startGrpcRequestTracing(
            transportId,
            ctx as GrpcCall,
            done,
          );
        }
        return this.startRpcRequestTracing(
          transportId,
          ctx as BaseRpcContext,
          done,
          target,
        );
      },
      composeStartHook,
    );

    setAgentHook<ProcessingEndHook>(
      target,
      "setOnProcessingEndHook",
      (transportId, ctx) => {
        this.endRpcRequestTracing(
          transportId,
          ctx as BaseRpcContext | GrpcCall,
        );
      },
      composeEndHook,
    );

    if (
      (target as { transportId?: unknown }).transportId ===
      this.microservices!.Transport.GRPC
    ) {
      this.rememberGrpcCalls(target);
    }
  }

  /**
   * Notes each call of a gRPC request stream by its metadata, for
   * `startGrpcRequestTracing` to find the call itself by.
   *
   * The start hook is handed a copy of the call, its fields spread onto a new
   * object (`{ ...call }`), and a copy emits nothing: the messages of the
   * request stream are emitted on the call. The copy shares the call's
   * `metadata`, so the call is kept by that, from the method grpc-js runs for
   * it - the only place the call itself passes before the hook. That method
   * is built by `createServiceMethod`, wrapped here on this server alone as
   * Nest calls it once per method when the server starts to listen, after
   * this hook was set. Unary and server-streaming calls are left alone: they
   * have no later messages to run anywhere. A server without the method keeps
   * its calls' events where grpc-js emits them.
   */
  private rememberGrpcCalls(target: Server): void {
    const server = target as unknown as {
      createServiceMethod?: CreateServiceMethod;
    };
    const original = server.createServiceMethod;
    if (typeof original !== "function" || this.grpcServers.has(target)) {
      return;
    }
    this.grpcServers.add(target);
    const calls = this.grpcCalls;
    const passThrough =
      this.microservices!.GrpcMethodStreamingType.PT_STREAMING;
    server.createServiceMethod = function (
      this: unknown,
      methodHandler,
      protoNativeHandler,
      streamType,
    ) {
      const method = original.call(
        this,
        methodHandler,
        protoNativeHandler,
        streamType,
      );
      if (!protoNativeHandler?.requestStream || typeof method !== "function") {
        return method;
      }
      const streamCall = streamType === passThrough;
      return function (this: unknown, call: unknown, ...rest: unknown[]) {
        const metadata = (call as { metadata?: unknown } | null)?.metadata;
        if (typeof metadata === "object" && metadata !== null) {
          calls.set(metadata, { call: call as GrpcServerCall, streamCall });
        }
        return (method as (...args: unknown[]) => unknown).call(
          this,
          call,
          ...rest,
        );
      };
    };
  }

  /** The call `ctx` is a copy of, if `rememberGrpcCalls` noted it. */
  private takeGrpcCall(ctx: GrpcCall): RememberedGrpcCall | undefined {
    const metadata: unknown = ctx?.metadata;
    if (typeof metadata !== "object" || metadata === null) {
      return undefined;
    }
    const remembered = this.grpcCalls.get(metadata);
    this.grpcCalls.delete(metadata);
    return remembered;
  }

  /**
   * Drops the trace of a `@GrpcStreamCall` call that is cancelled while its
   * handler is still running, as the HTTP agent drops an aborted request's.
   *
   * Nest ends a call's operation when its handler settles, and for a
   * `@GrpcStreamCall` handler it waits on that alone. On a deadline or a
   * client's cancellation grpc-js emits `cancelled` and destroys the stream,
   * with no `end` and no `error`, so a handler that waits for either never
   * settles: its trace stayed in the registry for the life of the process,
   * one per call, and was never reported. Unary and `@GrpcStreamMethod` calls
   * are left to Nest, which ends them on `cancelled` itself.
   *
   * Dropped a turn after `cancelled`, not at once: a handler that settles on
   * it is ended by Nest, from microtasks, before then, and reported as ever.
   * One that settles later outlived its client, and the registry already
   * lets it end its spans on a trace that is gone.
   */
  private dropTraceOnCancel(
    call: GrpcServerCall,
    operation: OperationState,
    registryKey: string,
  ): void {
    const drop = () => {
      setImmediate(() => {
        if (operation.endedAt !== undefined) {
          // Nest's end hook ran: ended and reported, or on its way.
          return;
        }
        endOperation(operation);
        this.operationTraceRegistry.abandonTrace(registryKey);
      });
    };
    if (call.cancelled === true) {
      // Cancelled before an application's start hook let the call through.
      drop();
      return;
    }
    call.once?.("cancelled", drop);
  }

  /**
   * Runs the events of a gRPC request stream in the call's store.
   *
   * A listener runs in the async context of whatever emits its event. The
   * messages already queued when the handler subscribes are emitted from
   * within `done`, inside the store; every later one from grpc-js's callback
   * on the HTTP/2 stream, which belongs to the connection and has no store.
   * So the second message of an ordinary stream was handled outside its call:
   * no spans, no trace id on its log lines, and `TracerService.createSpan()`
   * threw - a status 2 for a `@GrpcStreamMethod` handler, and for a
   * `@GrpcStreamCall` handler's `data` listener an uncaught rejection that
   * ended the process.
   *
   * An event emitted from within the call - a span of it writing to the
   * stream - keeps the context it is emitted in, the span's, which carries
   * the call's key.
   */
  private emitCallEventsInStore(
    call: GrpcServerCall,
    store: Map<KeyOf<Store>, any>,
    registryKey: string,
  ): void {
    if (typeof call.emit !== "function") {
      return;
    }
    const asyncLocalStorage = this.asyncLocalStorage;
    const emit = call.emit;
    call.emit = function (this: unknown, ...args) {
      if (
        asyncLocalStorage.getStore()?.get(TRACE_REGISTRY_KEY) === registryKey
      ) {
        return Reflect.apply(emit, this, args);
      }
      return asyncLocalStorage.run(store, () =>
        Reflect.apply(emit, this, args),
      );
    };
  }

  /**
   * Names the transport for the snapshot's `protocol` field.
   *
   * A custom transport is registered under a symbol rather than a `Transport`
   * member, and indexing the enum with one yields `undefined` - so every custom
   * transport used to arrive with no protocol at all.
   */
  private toProtocolName(transportId: Transport | symbol): string {
    return typeof transportId === "symbol"
      ? transportId.description ?? "custom"
      : this.microservices!.Transport[transportId];
  }

  startRpcRequestTracing(
    transportId: Transport | symbol,
    ctx: BaseRpcContext,
    done: () => Promise<any>,
    /** The server the message arrived at. */
    target?: Server,
  ): Promise<unknown> {
    // The same map `run` is given, rather than `getStore()` inside the callback:
    // identical object, one lookup fewer, and it is known to exist.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      const traceId = generateTraceIdSafely(
        this.options.traceIdGenerator,
        ctx,
        this.options,
        this.logger,
      );
      store.set(this.options.traceIdKey, traceId);

      // Fan-out calls and retries can share a correlation id. Claim this
      // execution before option callbacks can reach another operation's trace.
      const registryKey = uuidv7();
      store.set(TRACE_REGISTRY_KEY, registryKey);
      this.rememberRegistryKey(ctx, registryKey);
      // Ended by the end hook, recorded or not: see `liveTraceId`.
      this.rememberOperation(ctx, openOperation(store));

      // With OpenTelemetry interop on, the handler runs in the W3C trace
      // context the message was sent in, for an OpenTelemetry SDK in this
      // process - see `continueHandedOnTrace`. Recorded or not, as an
      // outbound call carries the trace on for an unrecorded request.
      const handedOn = this.openTelemetryInteropOn()
        ? handedOnTraceparent(ctx)
        : undefined;
      const handle =
        handedOn === undefined
          ? done
          : () => continueHandedOnTrace(handedOn, traceId, done);
      // And the handler's span goes under the span that sent the message, for
      // `otlp`, while the calls it makes carry the caller's decision on - as
      // a request's do with the `traceparent` it arrived with.
      const traceContext = handedOnTraceContext(handedOn, traceId);
      if (traceContext) {
        store.set(TRACE_CONTEXT_KEY, traceContext);
      }

      setAttributesSafely(
        this.options.rpc?.setAttributes,
        [transportId, ctx],
        this.options.rpc,
        store,
        this.logger,
        "rpc",
        this.options.traceIdKey,
      );

      if (
        shouldIgnoreSafely(
          this.options.rpc?.ignore,
          [transportId, ctx],
          this.options.rpc,
          this.logger,
          "rpc",
        )
      ) {
        return handle();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("rpc", {
        transport: transportId.toString(),
        ctx: ctx,
      });
      if (!shouldCapture) {
        return handle();
      }
      this.operationTraceRegistry.startTrace(
        registryKey,
        {
          protocol: this.toProtocolName(transportId),
          operationId: this.getOperationIdFromContext(ctx, target),
          tags: this.options.rpc?.tags,
        },
        traceId,
        traceContext,
      );
      return handle();
    });
  }

  /**
   * Whether OpenTelemetry interop runs now: `openTelemetry` on, beside
   * reporting to NestJS Observe - see `ObserveAgentSharedBuffer.isReporting`.
   */
  private openTelemetryInteropOn(): boolean {
    return (
      this.options.openTelemetry === true &&
      this.observeAgentSharedBuffer.isReporting()
    );
  }

  startGrpcRequestTracing(
    transportId: Transport | symbol,
    call: GrpcCall,
    done: () => Promise<any>,
  ): Promise<unknown> {
    // As above: the map `run` is given, not looked back up.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      const traceId = generateTraceIdSafely(
        this.options.traceIdGenerator,
        call,
        this.options,
        this.logger,
      );
      store.set(this.options.traceIdKey, traceId);

      // The key must precede callbacks here too.
      const registryKey = uuidv7();
      store.set(TRACE_REGISTRY_KEY, registryKey);
      // Nest ends a gRPC call with its request message rather than the
      // context it started it with, so the key is kept by both.
      this.rememberRegistryKey(call, registryKey);
      this.rememberRegistryKey(call?.request, registryKey);
      const operation = openOperation(store);
      this.rememberOperation(call, operation);
      this.rememberOperation(call?.request, operation);
      const grpcCall = this.takeGrpcCall(call);
      if (grpcCall) {
        // Recorded or not: `TracerService` needs the store either way.
        this.emitCallEventsInStore(grpcCall.call, store, registryKey);
        if (grpcCall.streamCall) {
          this.dropTraceOnCancel(grpcCall.call, operation, registryKey);
        }
      }

      // As for a message: the call's span goes under the caller's for `otlp`,
      // and the calls the handler makes carry its decision on. Read now, while
      // the span a gRPC instrumentation opened for the call is the active one.
      // Unlike a message's, the handler is not run in the caller's trace: the
      // SDK's gRPC instrumentation carries it there.
      const traceContext = this.openTelemetryInteropOn()
        ? handedOnTraceContext(grpcTraceparent(call), traceId)
        : undefined;
      if (traceContext) {
        store.set(TRACE_CONTEXT_KEY, traceContext);
      }

      setAttributesSafely(
        this.options.grpc?.setAttributes,
        [call],
        this.options.grpc,
        store,
        this.logger,
        "grpc",
        this.options.traceIdKey,
      );

      // `done` runs before the hook returns, as for any other transport. Nest
      // listens for the call's `cancelled` and `end` events inside it, and
      // grpc-js emits `cancelled` once: run from a timer, a call cancelled or
      // past its deadline on arrival had nothing listening, and a
      // client-streaming handler waited for good on a request stream that
      // never ended, its trace held in the registry.
      if (
        shouldIgnoreSafely(
          this.options.grpc?.ignore,
          [call],
          this.options.grpc,
          this.logger,
          "grpc",
        )
      ) {
        return done();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("grpc", {
        call,
      });
      if (!shouldCapture) {
        return done();
      }
      this.operationTraceRegistry.startTrace(
        registryKey,
        {
          protocol: this.toProtocolName(transportId),
          operationId: call.operationId,
          tags: this.options.grpc?.tags,
        },
        traceId,
        traceContext,
      );
      return done();
    });
  }

  endRpcRequestTracing(
    transportId: Transport | symbol,
    ctx: BaseRpcContext | GrpcCall,
  ): void {
    // The key this context was started under, wherever its reply stream
    // ended. The store answers only for a context no key could be kept by:
    // a gRPC call with no request message of its own, as a client stream has
    // none.
    endOperation(
      (typeof ctx === "object" && ctx !== null
        ? this.operations.get(ctx)
        : undefined) ??
        (this.asyncLocalStorage
          .getStore()
          ?.get(OPERATION_STATE_KEY as KeyOf<Store>) as
          | OperationState
          | undefined),
    );
    const registryKey =
      (typeof ctx === "object" && ctx !== null
        ? this.registryKeys.get(ctx)
        : undefined) ??
      this.asyncLocalStorage.getStore()?.get(TRACE_REGISTRY_KEY);
    if (
      typeof registryKey !== "string" ||
      !this.operationTraceRegistry.hasTrace(registryKey)
    ) {
      return;
    }
    const isGrpc = transportId === this.microservices!.Transport.GRPC;
    deferTraceCompletion(
      async () => {
        let userId: string | undefined;
        if (isGrpc) {
          userId = getUserIdSafely(
            this.options.grpc?.getUserId,
            [ctx as GrpcCall],
            this.options.grpc,
            this.logger,
            "grpc",
          );
        } else {
          userId = getUserIdSafely(
            this.options.rpc?.getUserId,
            [transportId, ctx as BaseRpcContext],
            this.options.rpc,
            this.logger,
            "rpc",
          );
        }
        this.operationTraceRegistry.endTrace(registryKey, {
          userId,
        });

        const snapshot =
          await this.operationTraceRegistry.pluckSnapshot(registryKey);
        if (!snapshot) {
          return;
        }
        this.observeAgentSharedBuffer.insertRequestSnapshot(
          snapshot as RequestSnapshot,
        );
      },
      this.logger,
      isGrpc ? "grpc" : "rpc",
      () => this.operationTraceRegistry.hasOpenSpans(registryKey),
    );
  }

  /**
   * Keeps `registryKey` for the end hook to find by `ctx`. A custom
   * transporter delivers a context of its own making, and a gRPC call need not
   * carry a request message: what cannot key a `WeakMap` is left to the store.
   */
  private rememberRegistryKey(ctx: unknown, registryKey: string): void {
    if (typeof ctx === "object" && ctx !== null) {
      this.registryKeys.set(ctx, registryKey);
    }
  }

  /** As `rememberRegistryKey`, for the operation the end hook ends. */
  private rememberOperation(ctx: unknown, operation: OperationState): void {
    if (typeof ctx === "object" && ctx !== null) {
      this.operations.set(ctx, operation);
    }
  }

  /**
   * The route a message's handler is registered under, for the pattern or
   * topic as its sender wrote it. Nest parses a pattern that is JSON and finds
   * the handler by the normalised outcome, so one handler answers to any
   * number of texts - other whitespace, an escape, a key given twice. Named by
   * the text, each was an operation of the sender's choosing, and a route an
   * `@Objective` on the handler was declared for anew.
   *
   * The route is taken only where the server finds that route's handler for
   * the text: a handler reached through a wildcard keeps the text it was
   * reached on, and so does anything the server cannot be asked about.
   */
  private toRoute(text: string, target: Server | undefined): string {
    if (!target) {
      return text;
    }
    try {
      const handlers = target.getHandlers();
      // What a Nest client sends: the route itself. One lookup, no parse.
      if (handlers.has(text)) {
        return text;
      }
      // Protected in Nest's typings, so read by shape.
      const route = (
        target as unknown as {
          getRouteFromPattern?: (pattern: string) => unknown;
        }
      ).getRouteFromPattern?.(text);
      if (typeof route !== "string" || route === text) {
        return text;
      }
      const handler = handlers.get(route);
      return handler !== undefined &&
        handler === target.getHandlerByPattern(text)
        ? route
        : text;
    } catch {
      return text;
    }
  }

  /**
   * Kafka, MQTT, RabbitMQ and TCP find a message's handler by the text its
   * context carries - see `toRoute`. NATS and Redis find it by the
   * subscription the message came in on.
   */
  private getOperationIdFromContext(
    ctx: BaseRpcContext,
    target?: Server,
  ): string {
    const {
      KafkaContext,
      MqttContext,
      NatsContext,
      RedisContext,
      RmqContext,
      TcpContext,
    } = this.microservices!;
    switch (true) {
      case ctx instanceof KafkaContext:
      case ctx instanceof MqttContext:
        return this.toRoute(ctx.getTopic(), target);
      case ctx instanceof RmqContext:
      case ctx instanceof TcpContext:
        return this.toRoute(ctx.getPattern(), target);
      case ctx instanceof RedisContext:
        return ctx.getChannel();
      case ctx instanceof NatsContext:
        return ctx.getSubject();
      default: {
        // A custom transporter delivers its own context class - expected, per
        // `toProtocolName` - and there is no universal accessor for its
        // routing key. Throwing here would fail the message before `done()`
        // ever ran, so fall back to a conventional accessor when one exists.
        const pattern = readContextAccessor(ctx, "getPattern");
        return typeof pattern === "string"
          ? this.toRoute(pattern, target)
          : "unknown";
      }
    }
  }
}

/**
 * The start hook the server is given: the application's outside, and the
 * agent's inside the `done` it is handed, returning what the application's
 * returns. The application's hook decides whether a message is handled at
 * all, and the agent opens a trace only once it is: one the application
 * refuses by never calling `done` leaves nothing behind, where the other way
 * round each would leave a trace open in the registry.
 */
function composeStartHook(
  application: ProcessingStartHook | undefined,
  agent: ProcessingStartHook,
): ProcessingStartHook {
  if (!application) {
    return agent;
  }
  return function (this: unknown, transportId, ctx, done) {
    return application.call(
      this,
      transportId,
      ctx,
      () => agent.call(this, transportId, ctx, done) as Promise<any>,
    );
  };
}

/**
 * The end hook the server is given: the agent's first, inside the
 * application's as its start hook is, then the application's whatever the
 * agent's did.
 */
function composeEndHook(
  application: ProcessingEndHook | undefined,
  agent: ProcessingEndHook,
): ProcessingEndHook {
  if (!application) {
    return agent;
  }
  return function (this: unknown, transportId, ctx) {
    try {
      agent.call(this, transportId, ctx);
    } finally {
      application.call(this, transportId, ctx);
    }
  };
}

/**
 * The `traceparent` the sending service's agent put in the packet's metadata
 * beside `x-request-id` - see `traceparentToHandOn` - on a transport whose
 * packets carry metadata: TCP and Redis, from `@nestjs/microservices` 12.0.4.
 * Read as `defaultTraceIdGenerator` reads the id, and held to the spec by
 * `continueHandedOnTrace`.
 */
function handedOnTraceparent(ctx: BaseRpcContext): unknown {
  try {
    const metadata = readContextAccessor(ctx, "getMetadata");
    return (metadata as Record<string, unknown> | undefined)?.["traceparent"];
  } catch {
    // A context that cannot be read carries nothing to continue.
    return undefined;
  }
}

/**
 * The `traceparent` a gRPC call's metadata carries - a caller instrumented
 * with OpenTelemetry sends one, and so does one running the agent with
 * `openTelemetry` on - read off grpc-js's `Metadata`, whichever Nest release
 * handed the call over.
 */
function grpcTraceparent(call: GrpcCall): string | undefined {
  try {
    const metadata = call.metadata as
      | { get?: (key: string) => unknown[] }
      | undefined;
    const value = metadata?.get?.("traceparent")?.[0];
    return typeof value === "string" ? value : undefined;
  } catch {
    // Metadata that cannot be read carries nothing to continue.
    return undefined;
  }
}
