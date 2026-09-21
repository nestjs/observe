import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  ObserveModuleOptionsWithDefaults,
  RequestSnapshot,
  WsMessageContext,
} from "../interfaces/index.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import {
  describePeerLoadError,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";

type GatewayHandler = (...args: unknown[]) => unknown;

/** The `WsContextCreator` surface this service patches, structurally typed. */
interface WsContextCreatorLike {
  prototype?: {
    create?: (
      instance: object,
      callback: GatewayHandler,
      ...rest: unknown[]
    ) => GatewayHandler;
    [key: symbol]: unknown;
  };
}

const ORIGINAL_CREATE = Symbol.for("nestjs.observe.ws.create");

/** `@nestjs/websockets`' MESSAGE_METADATA - what `@SubscribeMessage()` writes. */
const MESSAGE_METADATA = "message";

/**
 * Gateway message tracing for `@nestjs/websockets`.
 *
 * Unlike the HTTP adapter and the microservice server, a gateway offers no
 * processing hooks, so the one place every `@SubscribeMessage()` handler
 * passes through is patched instead: `WsContextCreator.create`, which builds
 * the guards-pipes-interceptors-handler chain for a message. Wrapping what it
 * returns puts the whole chain inside the trace, whichever platform adapter -
 * socket.io, ws - delivers the message.
 */
@Injectable()
export class WsObserveAgentService<Store extends Record<string, unknown>> {
  private readonly logger = new Logger(WsObserveAgentService.name);

  constructor(
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly traceSamplerService: TraceSamplerService,
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
  ) {
    this.patchContextCreator();
  }

  private loadContextCreator(): WsContextCreatorLike | null | undefined {
    const result = loadOptionalPeer<{
      WsContextCreator?: WsContextCreatorLike;
    }>("@nestjs/websockets", "@nestjs/websockets/context/ws-context-creator");
    if (!result.installed) {
      return undefined;
    }
    if (result.error) {
      this.logger.warn(
        `@nestjs/websockets is installed but its context creator could not be loaded, so gateway messages will not be instrumented: ${describePeerLoadError(result.error)}`,
      );
      return null;
    }
    return result.module?.WsContextCreator ?? null;
  }

  private patchContextCreator() {
    const WsContextCreator = this.loadContextCreator();
    if (WsContextCreator === undefined) {
      // An optional peer. No gateways means nothing to wrap.
      return;
    }
    const prototype = WsContextCreator?.prototype;
    const originalCreate = (prototype?.[ORIGINAL_CREATE] ??
      prototype?.create) as NonNullable<
      WsContextCreatorLike["prototype"]
    >["create"];
    if (!prototype || typeof originalCreate !== "function") {
      this.logger.warn(
        "WsContextCreator is not available. Please, update to the latest version of @nestjs/websockets. Skipping patching.",
      );
      return;
    }
    // Parked under a symbol so a second agent replaces the wrapper instead of
    // wrapping it again.
    prototype[ORIGINAL_CREATE] = originalCreate;

    const trace = this.traceMessage.bind(this);
    const routeThroughInstance = this.routeThroughInstance.bind(this);
    prototype.create = function (
      this: unknown,
      instance: object,
      callback: GatewayHandler,
      ...rest: unknown[]
    ) {
      const handler = originalCreate.call(
        this,
        instance,
        // rest: [moduleKey, methodName, ...]
        routeThroughInstance(instance, callback, rest[1]),
        ...rest,
      );
      const pattern: unknown = Reflect.getMetadata?.(
        MESSAGE_METADATA,
        callback,
      );
      const gateway = instance?.constructor?.name || "Gateway";
      return (...args: unknown[]) =>
        trace(
          { gateway, pattern: String(pattern), client: args[0], data: args[1] },
          () => handler(...args),
        );
    };
  }

  /**
   * Nest reads a gateway's handlers off the class prototype and applies them
   * to the instance, which steps around the instrumentation proxy - the one
   * method of the whole chain that would go unrecorded is the handler itself,
   * and a handler that throws before calling anything leaves no span at all.
   *
   * The stand-in calls the same method through the instance instead. Guards,
   * pipes, filters and the message pattern are all looked up as metadata on
   * the callback, so that metadata is carried over.
   */
  private routeThroughInstance(
    instance: object,
    callback: GatewayHandler,
    methodName: unknown,
  ): GatewayHandler {
    if (typeof methodName !== "string" || typeof callback !== "function") {
      return callback;
    }
    const instrumented = (instance as Record<string, unknown>)[methodName];
    if (typeof instrumented !== "function" || instrumented === callback) {
      return callback;
    }
    const routed: GatewayHandler = function (this: unknown, ...args) {
      return (instrumented as GatewayHandler).apply(this, args);
    };
    Object.defineProperty(routed, "name", { value: callback.name });
    for (const key of Reflect.getMetadataKeys?.(callback) ?? []) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, callback), routed);
    }
    return routed;
  }

  private traceMessage(message: WsMessageContext, invoke: () => unknown) {
    // Always a store of its own: whatever context the socket's events happen
    // to fire in - the upgrade request, a polling request - is not this
    // message's operation.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      const traceId = uuidv7();
      store.set(this.options.traceIdKey, traceId);

      const attributes = this.options.ws?.setAttributes?.(message);
      if (attributes) {
        for (const [key, value] of Object.entries(attributes)) {
          store.set(key, value);
        }
      }

      if (
        this.options.ws?.ignore?.(message) ||
        !this.traceSamplerService.shouldCapture("ws", {
          gateway: message.gateway,
          pattern: message.pattern,
        })
      ) {
        return invoke();
      }

      this.operationTraceRegistry.startTrace(traceId, {
        protocol: "ws",
        operationId: `${message.gateway}:${message.pattern}`,
        tags: this.options.ws?.tags,
      });

      const endTrace = () => {
        setTimeout(async () => {
          this.operationTraceRegistry.endTrace(traceId, {
            userId: this.options.ws?.getUserId?.(message),
          });
          const snapshot =
            await this.operationTraceRegistry.pluckSnapshot(traceId);
          if (!snapshot) {
            return;
          }
          this.observeAgentSharedBuffer.insertRequestSnapshot(
            snapshot as RequestSnapshot,
          );
        }, 0);
      };

      // Nest's ws proxy hands a thrown error to the exception filter and
      // resolves, so there is no rejection to read a failure from here - the
      // handler's own span records it, and the registry lifts a failed root
      // span into the snapshot's status.
      let result: unknown;
      try {
        result = invoke();
      } catch (error) {
        endTrace();
        throw error;
      }
      if (result instanceof Promise) {
        return result.finally(endTrace);
      }
      endTrace();
      return result;
    });
  }
}
