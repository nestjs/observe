import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
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
import { handedOnTraceContext } from "../utils/trace-context.util.js";
import { continueHandedOnTrace } from "../utils/trace-handoff.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
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
>;

interface GrpcCall<TRequest = any, TMetadata = any> {
  request: TRequest;
  metadata: TMetadata;
  operationId: string;
}

@Injectable()
export class RpcObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RpcObserveAgentService.name);
  private rpcTargetAddedSubscription: Subscription | undefined;
  /**
   * Assigned in `onModuleInit`. Every use below is reached only through the
   * hooks registered there, after a successful load - a service without the
   * package has no RPC target to hook.
   */
  private microservices: Microservices | undefined;

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
  ) {}

  onModuleInit() {
    this.microservices = this.loadMicroservices();
    if (!this.microservices) {
      return;
    }
    this.rpcTargetAddedSubscription = this.modulesContainer
      .getRpcTargetRegistry?.<Server>()
      .subscribe((target) => this.registerRpcHooks(target));
  }

  onModuleDestroy() {
    if (this.rpcTargetAddedSubscription) {
      this.rpcTargetAddedSubscription.unsubscribe();
    }
  }

  /**
   * Loads `@nestjs/microservices` without a static import, so a service that
   * exposes no microservice need not install the package. Loaded here rather
   * than lazily because the target registry is subscribed from `onModuleInit`,
   * and a dynamic `import()` would resolve after a target may already have
   * been announced.
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

  registerRpcHooks(target: Server) {
    // Return `done()`'s promise, as Nest's default hook does. Nest's servers
    // hand it back from their message handlers: kafkajs waits on it to commit
    // the offset or retry the message, and recent Nest versions log its
    // rejection for most other transports.
    target.setOnProcessingStartHook(
      (
        transportId: Transport | symbol,
        ctx: unknown,
        done: () => Promise<any>,
      ) => {
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
        );
      },
    );

    target.setOnProcessingEndHook(
      (transportId: Transport | symbol, ctx: unknown) => {
        this.endRpcRequestTracing(
          transportId,
          ctx as BaseRpcContext | GrpcCall,
        );
      },
    );
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
          operationId: this.getOperationIdFromContext(ctx),
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
    const store = this.asyncLocalStorage.getStore();
    if (!store) {
      return;
    }
    const registryKey = store.get(TRACE_REGISTRY_KEY);
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

  private getOperationIdFromContext(ctx: BaseRpcContext): string {
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
        return ctx.getTopic();
      case ctx instanceof RmqContext:
      case ctx instanceof TcpContext:
        return ctx.getPattern();
      case ctx instanceof RedisContext:
        return ctx.getChannel();
      case ctx instanceof NatsContext:
        return ctx.getSubject();
      default: {
        // A custom transporter delivers its own context class - expected, per
        // `toProtocolName` - and there is no universal accessor for its
        // routing key. Throwing here would fail the message before `done()`
        // ever ran, so fall back to a conventional accessor when one exists.
        const pattern = (ctx as { getPattern?: () => unknown })?.getPattern?.();
        return typeof pattern === "string" ? pattern : "unknown";
      }
    }
  }
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
    const getMetadata = (ctx as { getMetadata?: unknown } | null)?.getMetadata;
    if (typeof getMetadata !== "function") {
      return undefined;
    }
    const metadata: unknown = getMetadata.call(ctx);
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
