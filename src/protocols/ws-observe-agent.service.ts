import { Inject, Injectable, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { isObservable, Observable } from "rxjs";
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
import {
  deferTraceCompletion,
  getUserIdSafely,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";

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

/** The traces a client's messages still hold open. */
interface ClientTraces {
  /** One abandon per open trace, removed as the trace ends. */
  readonly open: Set<() => void>;
  /** Set once the client's disconnect has been seen. */
  gone: boolean;
}

/** The surface of a socket.io or `ws` socket read here, structurally typed. */
interface ClientLike {
  once?: (event: string, listener: () => void) => unknown;
  disconnect?: unknown;
  disconnected?: unknown;
  readyState?: unknown;
}

/** `ws`' `WebSocket.CLOSED`. */
const WS_CLOSED = 3;

/**
 * A traced message's state, kept in its store - and so in every span's copy
 * of it - where the handler's stand-in finds the message it is called for.
 */
interface MessageState {
  /** Set when Nest calls the handler. */
  handlerCalled: boolean;
  /**
   * Ends the trace of a message whose chain was handed over before the
   * handler ran, once the handler returns a stream. Cleared with the trace.
   */
  onStreamReturned?: () => void;
}

const MESSAGE_STATE = Symbol("nestjs.observe.ws.message");

const noop = () => undefined;

/**
 * Gateway message tracing for `@nestjs/websockets`.
 *
 * Unlike the HTTP adapter and the microservice server, a gateway offers no
 * processing hooks, so the one place every `@SubscribeMessage()` handler
 * passes through is patched instead: `WsContextCreator.create`, which builds
 * the guards-pipes-interceptors-handler chain for a message. Wrapping what it
 * returns, and subscribing to the stream it resolves to in the same store,
 * puts the whole chain inside the trace, whichever platform adapter -
 * socket.io, ws - delivers the message.
 */
@Injectable()
export class WsObserveAgentService<Store extends Record<string, unknown>> {
  private readonly logger = new Logger(WsObserveAgentService.name);
  private readonly tracesByClient = new WeakMap<object, ClientTraces>();
  private readonly standIns = new WeakMap<GatewayHandler, GatewayHandler>();

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
    const standInFor = this.standInFor.bind(this);
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
        standInFor(instance, callback, rest[1]),
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
   * The handler Nest is given for a `@SubscribeMessage()` method: the same
   * method, called through the instance, telling the message when it runs.
   *
   * Nest reads a gateway's handlers off the class prototype and applies them
   * to the instance, which steps around the instrumentation proxy - the one
   * method of the whole chain that would go unrecorded is the handler itself,
   * and a handler that throws before calling anything leaves no span at all.
   * The stand-in calls the same method through the instance instead.
   *
   * Behind an interceptor, the chain is cold: Nest's proxy resolves to a
   * stream once the guards have run, and the interceptors, the pipes and the
   * handler run only when the adapter subscribes to it. The stand-in marks
   * the message's state when it is called, so the trace can tell which of
   * the two it was handed, and ends that trace when the handler returns a
   * stream of its own.
   *
   * Guards, pipes, filters and the message pattern are all looked up as
   * metadata on the callback, so that metadata is carried over - once per
   * method, since on a request-scoped path `create` runs for every message.
   */
  private standInFor(
    instance: object,
    callback: GatewayHandler,
    methodName: unknown,
  ): GatewayHandler {
    if (typeof callback !== "function") {
      return callback;
    }
    const instrumented =
      typeof methodName === "string"
        ? (instance as Record<string, unknown> | undefined)?.[methodName]
        : undefined;
    const target = (
      typeof instrumented === "function" ? instrumented : callback
    ) as GatewayHandler;
    const cached = this.standIns.get(target);
    if (cached) {
      return cached;
    }
    const als = this.asyncLocalStorage;
    const standIn: GatewayHandler = function (this: unknown, ...args) {
      const state = als.getStore()?.get(MESSAGE_STATE as KeyOf<Store>) as
        | MessageState
        | undefined;
      if (state) {
        state.handlerCalled = true;
      }
      const result = target.apply(this, args);
      if (state?.onStreamReturned && isObservable(result)) {
        state.onStreamReturned();
      }
      return result;
    };
    Object.defineProperty(standIn, "name", { value: callback.name });
    for (const key of Reflect.getMetadataKeys?.(callback) ?? []) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, callback), standIn);
    }
    this.standIns.set(target, standIn);
    return standIn;
  }

  /**
   * Drops a message's trace when its client goes away before the handler
   * settles, and returns what stops watching for that once the trace ends.
   *
   * A handler waiting on its client - an acknowledgement without a timeout,
   * the client's next frame - never settles once the client has gone, and
   * nothing else would end its trace: every client that hung up on one left
   * its snapshot registered for the life of the process, and a client that
   * reconnects can leave as many as it likes.
   *
   * One listener per client, however many messages it has in flight, on the
   * events Nest's adapters stop a client's messages at: socket.io's
   * `disconnect`, `ws`' `close`. Dropped at once, as the HTTP agent drops an
   * aborted request: an abandoned trace is never reported, and the registry
   * lets a handler that outlives its client end its spans on a trace that is
   * gone. A client that is no event emitter - a custom adapter's - is not
   * watched.
   */
  private abandonWhenClientLeaves(
    client: unknown,
    abandon: () => void,
  ): () => void {
    const socket = client as ClientLike | null | undefined;
    if (typeof socket?.once !== "function") {
      return noop;
    }
    let traces = this.tracesByClient.get(socket);
    if (!traces) {
      const watched: ClientTraces = { open: new Set(), gone: false };
      try {
        socket.once(
          typeof socket.disconnect === "function" ? "disconnect" : "close",
          () => {
            watched.gone = true;
            // One macrotask later, not at once: a handler that ends its own
            // client's connection - a logout, a kick - is still running when
            // socket.io emits this, from inside `disconnect()`, and would
            // lose the trace it is about to finish. A trace that settles
            // meanwhile has left `open`; the rest are still dropped, a tick
            // after the client left.
            setImmediate(() => {
              for (const abandonTrace of watched.open) {
                abandonTrace();
              }
              watched.open.clear();
            });
          },
        );
      } catch {
        return noop;
      }
      this.tracesByClient.set(socket, watched);
      traces = watched;
    }
    // Gone before the message was traced: a request-scoped gateway resolves
    // its instance before the chain runs, and the client can leave meanwhile.
    if (
      traces.gone ||
      socket.disconnected === true ||
      socket.readyState === WS_CLOSED
    ) {
      abandon();
      return noop;
    }
    const open = traces.open;
    open.add(abandon);
    return () => void open.delete(abandon);
  }

  private traceMessage(message: WsMessageContext, invoke: () => unknown) {
    // Always a store of its own: whatever context the socket's events happen
    // to fire in - the upgrade request, a polling request - is not this
    // message's operation.
    const store = new Map<KeyOf<Store>, any>();
    return this.asyncLocalStorage.run(store, () => {
      const traceId = uuidv7();
      store.set(this.options.traceIdKey, traceId);

      setAttributesSafely(
        this.options.ws?.setAttributes,
        [message],
        this.options.ws,
        store,
        this.logger,
        "ws",
      );

      if (
        shouldIgnoreSafely(
          this.options.ws?.ignore,
          [message],
          this.options.ws,
          this.logger,
          "ws",
        ) ||
        !this.traceSamplerService.shouldCapture("ws", {
          gateway: message.gateway,
          pattern: message.pattern,
        })
      ) {
        // No trace to end, but the store - and the trace id it carries for
        // logs - still has to reach a chain the adapter subscribes to later.
        const result = invoke();
        return result instanceof Promise
          ? result.then((value) => this.keepStore(store, value))
          : this.keepStore(store, result);
      }

      this.operationTraceRegistry.startTrace(traceId, {
        protocol: "ws",
        operationId: `${message.gateway}:${message.pattern}`,
        tags: this.options.ws?.tags,
      });

      const state: MessageState = { handlerCalled: false };
      store.set(MESSAGE_STATE as KeyOf<Store>, state);

      // Ended or dropped once, whichever comes first: the handler settling,
      // or its client leaving. Closing also clears the end the state holds,
      // and with it the message and its client: span copies of the store can
      // outlive the message.
      let open = true;
      let unwatch: () => void = noop;
      const close = () => {
        if (!open) {
          return false;
        }
        open = false;
        unwatch();
        state.onStreamReturned = undefined;
        return true;
      };
      const abandon = () => {
        if (close()) {
          this.operationTraceRegistry.abandonTrace(traceId);
        }
      };
      unwatch = this.abandonWhenClientLeaves(message.client, abandon);

      const endTrace = () => {
        if (!close()) {
          return;
        }
        deferTraceCompletion(
          async () => {
            this.operationTraceRegistry.endTrace(traceId, {
              userId: getUserIdSafely(
                this.options.ws?.getUserId,
                [message],
                this.options.ws,
                this.logger,
                "ws",
              ),
            });
            const snapshot =
              await this.operationTraceRegistry.pluckSnapshot(traceId);
            if (!snapshot) {
              return;
            }
            this.observeAgentSharedBuffer.insertRequestSnapshot(
              snapshot as RequestSnapshot,
            );
          },
          this.logger,
          "ws",
          () => this.operationTraceRegistry.hasOpenSpans(traceId),
        );
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
      const settle = (value: unknown) => {
        if (!isObservable(value)) {
          endTrace();
          return value;
        }
        if (state.handlerCalled || !open) {
          // The handler has run and returned a stream - the trace covers the
          // handler, not the stream - or the trace is already gone.
          endTrace();
          return this.subscribeInStore(store, value);
        }
        // Behind an interceptor only the guards have run, and the rest of the
        // chain runs once the adapter subscribes. The trace ends with the
        // handler's stream, or with the chain's first word; a chain torn
        // down before either was given up on by the adapter.
        state.onStreamReturned = endTrace;
        return this.subscribeInStore(store, value, endTrace, abandon);
      };
      if (result instanceof Promise) {
        return result.then(settle, (error: unknown) => {
          endTrace();
          throw error;
        });
      }
      return settle(result);
    });
  }

  /** What the chain resolved to, a stream subscribed in the message's store. */
  private keepStore(store: Map<KeyOf<Store>, any>, value: unknown): unknown {
    return isObservable(value) ? this.subscribeInStore(store, value) : value;
  }

  /**
   * The chain's stream, subscribed in the message's store.
   *
   * Nest's adapters subscribe to what the chain resolves to from the socket's
   * own events, outside the store the message was started in. Behind an
   * interceptor that stream is all of the chain past the guards - the
   * interceptors, the pipes, the handler, the exception filter - and for a
   * handler that returns a stream, the stream and the filter its error goes
   * to. Run without the store, they were missing from the trace, and
   * `TracerService` failed in them.
   *
   * `end` is called at the stream's first value, error or completion, and
   * `abandon` when the subscription is torn down before any: Nest's adapters
   * unsubscribe a client's messages when it disconnects. Both are no-ops once
   * either has run.
   */
  private subscribeInStore(
    store: Map<KeyOf<Store>, any>,
    chain: Observable<unknown>,
    end?: () => void,
    abandon?: () => void,
  ): Observable<unknown> {
    return new Observable((subscriber) => {
      const subscription = this.asyncLocalStorage.run(store, () =>
        chain.subscribe({
          next: (value) => {
            end?.();
            subscriber.next(value);
          },
          error: (error: unknown) => {
            end?.();
            subscriber.error(error);
          },
          complete: () => {
            end?.();
            subscriber.complete();
          },
        }),
      );
      if (abandon) {
        subscription.add(abandon);
      }
      return subscription;
    });
  }
}
