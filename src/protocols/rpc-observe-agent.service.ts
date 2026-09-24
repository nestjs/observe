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
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";

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
      const traceId = this.options.traceIdGenerator(ctx);
      store.set(this.options.traceIdKey, traceId);

      if (this.options.rpc?.setAttributes) {
        const attributes = this.options.rpc?.setAttributes?.(transportId, ctx);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      // setImmediate(() => {
      if (this.options.rpc?.ignore?.(transportId, ctx)) {
        return done();
      }

      const shouldCapture = this.traceSamplerService.shouldCapture("rpc", {
        transport: transportId.toString(),
        ctx: ctx,
      });
      if (!shouldCapture) {
        return done();
      }
      this.operationTraceRegistry.startTrace(traceId, {
        protocol: this.toProtocolName(transportId),
        operationId: this.getOperationIdFromContext(ctx),
        tags: this.options.rpc?.tags,
      });
      return done();
      // });
    });
  }

  startGrpcRequestTracing(
    transportId: Transport | symbol,
    call: GrpcCall,
    done: () => Promise<any>,
  ): Promise<unknown> {
    // As above: the map `run` is given, not looked back up.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      const traceId = this.options.traceIdGenerator(call);
      store.set(this.options.traceIdKey, traceId);

      if (this.options.grpc?.setAttributes) {
        const attributes = this.options.grpc?.setAttributes?.(call);
        if (attributes) {
          for (const [key, value] of Object.entries(attributes)) {
            store.set(key, value);
          }
        }
      }

      return new Promise<unknown>((resolve) => {
        setTimeout(() => {
          if (this.options.grpc?.ignore?.(call)) {
            return resolve(done());
          }

          const shouldCapture = this.traceSamplerService.shouldCapture("grpc", {
            call,
          });
          if (!shouldCapture) {
            return resolve(done());
          }
          this.operationTraceRegistry.startTrace(traceId, {
            protocol: this.toProtocolName(transportId),
            operationId: call.operationId,
            tags: this.options.grpc?.tags,
          });
          resolve(done());
        }, 0);
      });
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
    const traceId = store.get(this.options.traceIdKey);
    if (!traceId) {
      return;
    }
    setTimeout(async () => {
      let userId: string | undefined;
      if (transportId === this.microservices!.Transport.GRPC) {
        if (this.options.grpc?.getUserId) {
          userId = this.options.grpc?.getUserId?.(ctx as GrpcCall);
        }
      } else {
        if (this.options.rpc?.getUserId) {
          userId = this.options.rpc?.getUserId?.(
            transportId,
            ctx as BaseRpcContext,
          );
        }
      }
      this.operationTraceRegistry.endTrace(traceId, {
        userId,
      });

      const snapshot = await this.operationTraceRegistry.pluckSnapshot(traceId);
      if (!snapshot) {
        return;
      }
      this.observeAgentSharedBuffer.insertRequestSnapshot(
        snapshot as RequestSnapshot,
      );
    }, 0);
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
        const pattern = (
          ctx as { getPattern?: () => unknown }
        )?.getPattern?.();
        return typeof pattern === "string" ? pattern : "unknown";
      }
    }
  }
}
