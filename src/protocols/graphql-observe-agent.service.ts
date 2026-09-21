import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, ModuleRef } from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import {
  GraphQLResolveInfoLike,
  RequestSnapshot,
} from "../interfaces/index.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import {
  CALLER_METADATA_KEY,
  OBSERVE_OPTIONS,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { KeyOf } from "../types/key-of.type.js";
import {
  parseGraphQLOperation,
  toResolveInfoLike,
} from "./graphql-operation-parser.js";

/**
 * Protocol recorded for a GraphQL operation that arrived over something other
 * than an instrumented HTTP request. A query over HTTP keeps `http` as its
 * protocol, because that is what the request was; the GraphQL layer only
 * sharpens its operation id.
 */
const GRAPHQL_PROTOCOL = "graphql";

/**
 * `@nestjs/graphql`'s metadata keys, inlined as strings so the package stays an
 * optional peer. `@Query`/`@Mutation`/`@Subscription` stamp both onto the
 * resolver method: the root type it registers against, and the schema field
 * name when the decorator was given one (the method name serves otherwise).
 */
const RESOLVER_TYPE_METADATA = "graphql:resolver_type";
const RESOLVER_NAME_METADATA = "graphql:resolver_name";
const ROOT_TYPE_NAMES = new Set(["Query", "Mutation", "Subscription"]);

/** The class and method behind a root field, e.g. `OrdersResolver.orders`. */
interface ResolverHandler {
  className: string;
  methodKey: string;
}

/** The `ResolverDecoratorHost` surface this service uses, structurally typed. */
interface RequestHookHost {
  setOnRequestStartHook?: (
    hook: (ctx: GqlRequestStartContext) => unknown,
  ) => void;
  setOnRequestEndHook?: (hook: (ctx: GqlRequestEndContext) => void) => void;
}

interface GqlRequestStartContext {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

interface GqlRequestEndContext extends GqlRequestStartContext {
  /** `GraphQLError`s, structurally: the `graphql` package is an optional peer. */
  errors?: readonly { message?: string; originalError?: unknown }[];
  state?: unknown;
}

/**
 * What the start hook hands the end hook. Everything needed to close the
 * operation travels in here rather than in a map keyed by trace id, because an
 * unmatched start must not leave anything behind - see the Mercurius note on
 * `onRequestEnd`.
 */
interface OperationState {
  traceId: string;
  spanId: string;
  className: string;
  methodKey: string;
  /** The caller this operation displaced, restored once it ends. */
  previousCallerId: string | undefined;
  store: Map<string, unknown> | undefined;
  /** Whether this service opened the trace, and therefore has to ship it. */
  ownsTrace: boolean;
  context: unknown;
}

/**
 * GraphQL operation instrumentation.
 *
 * Nest serves GraphQL as raw middleware mounted on a single path, so from
 * HTTP's point of view every operation a service handles is one `POST /graphql`
 * with no route handler behind it. That is a problem in both directions: the
 * trace has no spans, so `OperationTraceRegistry.endTrace` discards it as a
 * request that never reached a handler, and even if it survived, every query
 * and mutation in the schema would aggregate into a single row.
 *
 * `@nestjs/graphql` exposes `ResolverDecoratorHost`, whose request-lifecycle
 * hooks bracket a single operation: `setOnRequestStartHook` fires before the
 * document is processed, `setOnRequestEndHook` once it has been, right before
 * the response goes out. Whatever the start hook returns is handed back as
 * `state`, which is what lets one span be opened in the first and closed in the
 * second. This service claims both and gives each operation a span.
 *
 * The span goes into the trace the HTTP agent already opened whenever there is
 * one, which keeps the shape a reader expects: one snapshot per HTTP request,
 * with `Query.orders` as the operation id and the operation - plus every
 * instrumented provider it reached - as the trace tree underneath. Only when no
 * such trace exists does this service open one of its own.
 *
 * Measuring the operation rather than each root field is the point of using
 * these hooks over the resolver decorator they replace. A span now covers
 * parsing, validation and execution together, which is the number a client
 * actually waited for; a document selecting several root fields is one span
 * instead of several competing to name the trace; and a resolver that calls
 * nothing instrumented still produces a trace rather than being discarded for
 * having recorded no spans.
 */
@Injectable()
export class GraphQLObserveAgentService<Store extends Record<string, unknown>>
  implements OnModuleInit
{
  private readonly logger = new Logger(GraphQLObserveAgentService.name);
  private isPatched = false;
  /**
   * `Query.orders` -> the resolver class and method that registered it. Built
   * lazily on the first operation, by which point every provider exists.
   * `undefined` until then; never rebuilt, because resolvers cannot be added
   * after the schema is built.
   */
  private resolverIndex: Map<string, ResolverHandler> | undefined;

  constructor(
    private readonly asyncLocalStorage: AsyncLocalStorage<
      Map<KeyOf<Store>, any>
    >,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    private readonly traceSamplerService: TraceSamplerService,
    private readonly moduleRef: ModuleRef,
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {
    // Attempted twice, and idempotent, because `GraphQLModule` may be
    // instantiated on either side of this service. Whichever module Nest
    // reaches first, one of the two attempts lands: if GraphQLModule came
    // first, the host already exists here in the constructor; if it comes
    // after, every provider is nonetheless constructed before any init hook
    // runs, so the `onModuleInit` attempt below finds it. The hooks themselves
    // are read lazily at request time, so registering late is safe either way.
    void this.registerRequestHooksIfPossible();
  }

  async onModuleInit(): Promise<void> {
    await this.registerRequestHooksIfPossible();
  }

  async registerRequestHooksIfPossible(): Promise<void> {
    if (this.isPatched) {
      return;
    }

    let ResolverDecoratorHost: unknown;
    try {
      ({ ResolverDecoratorHost } = (await import("@nestjs/graphql")) as {
        ResolverDecoratorHost?: unknown;
      });
    } catch {
      // The @nestjs/graphql package is an optional peer. A service that does not
      // speak GraphQL has nothing to patch, and that is not a misconfiguration.
      return;
    }
    if (!ResolverDecoratorHost) {
      // Installed, but too old to expose the host. Worth saying out loud: the
      // symptom otherwise is a GraphQL service that silently reports nothing.
      this.logger.warn(
        "The installed version of @nestjs/graphql does not expose 'ResolverDecoratorHost', so GraphQL operations cannot be instrumented. Upgrade @nestjs/graphql to collect per-operation traces.",
      );
      return;
    }

    let host: RequestHookHost | undefined;
    try {
      host = this.moduleRef.get(ResolverDecoratorHost as never, {
        strict: false,
      });
    } catch {
      // GraphQLModule is not registered in this application, or has not been
      // instantiated yet - the second attempt, from onModuleInit, decides.
      return;
    }
    if (!host) {
      return;
    }

    if (
      typeof host.setOnRequestStartHook !== "function" ||
      typeof host.setOnRequestEndHook !== "function"
    ) {
      // The host predates the request-lifecycle hooks. Deliberately not falling
      // back to `setDecorator`: two ways of measuring the same operation, only
      // one of which is exercised, is worse than one that says why it is off.
      this.logger.warn(
        "The installed version of @nestjs/graphql does not expose the GraphQL request lifecycle hooks ('setOnRequestStartHook' / 'setOnRequestEndHook'), so GraphQL operations cannot be instrumented. Upgrade @nestjs/graphql to collect per-operation traces.",
      );
      return;
    }

    host.setOnRequestStartHook((ctx) => this.onRequestStart(ctx));
    host.setOnRequestEndHook((ctx) => this.onRequestEnd(ctx));
    this.isPatched = true;
  }

  /**
   * Opens a span for the operation about to be processed.
   *
   * Returns the state the end hook needs, or `undefined` for an operation this
   * does not measure - one that was ignored, sampled out, or whose document
   * nothing could be learned from. `undefined` is the end hook's signal to do
   * nothing, so the two stay paired without a second flag.
   *
   * Hook exceptions are not swallowed by the driver, so nothing in here may
   * throw on a caller's behalf: a failure to label a trace must not turn into a
   * failed GraphQL request.
   */
  onRequestStart(ctx: GqlRequestStartContext): OperationState | undefined {
    const parsed = parseGraphQLOperation(ctx.query);
    if (!parsed) {
      return undefined;
    }
    const operationName = parsed.operationName ?? ctx.operationName;
    const info = toResolveInfoLike({
      ...parsed,
      operationName,
    });

    if (this.options.graphql?.ignore?.(info)) {
      return undefined;
    }

    const operationId = `${info.parentType.name}.${info.fieldName}`;

    // The document replaces the transport's originalUrl. Every operation over
    // HTTP shares one mount path, so `/graphql` says nothing; the document is
    // what tells two requests to the same root field apart, and it lands in
    // the field every reader - detail views, search, the trigram index -
    // already treats as "what was this request". The operation name is not
    // recorded separately: a document that has one carries it inline.
    const attributes: RequestSnapshot["attributes"] = {
      originalUrl: parsed.sanitizedDocument,
    };

    const store = this.asyncLocalStorage.getStore();
    // The registry key, where the transport in front gave the request one
    // of its own; the trace id otherwise, which is then the key as well.
    const traceId =
      store?.get(TRACE_REGISTRY_KEY as KeyOf<Store>) ??
      store?.get(this.options.traceIdKey);

    if (traceId) {
      return this.startWithinRequest(
        traceId,
        operationId,
        attributes,
        info,
        ctx,
      );
    }
    return this.startAsOperation(operationId, attributes, info, ctx);
  }

  /**
   * Closes the span, and - when this service opened the trace - ends and ships
   * it.
   *
   * Not guaranteed to run for every start. Mercurius resolves an operation
   * through `onResolution`, which never fires for a document that failed
   * parsing or validation, so a start hook there can go unmatched. Nothing is
   * leaked when it does: the state lives in the hook's return value rather than
   * in this service, and the registry drops a trace whose spans never closed.
   * The one visible consequence is that a malformed document collects nothing
   * on Mercurius, which is what it collected before any of this existed.
   */
  onRequestEnd(ctx: GqlRequestEndContext): void {
    const state = ctx.state as OperationState | undefined;
    if (!state) {
      return;
    }

    if (state.store) {
      // Handing the request back whatever owned it before this operation. The
      // store is shared by reference across the request, so this is a real
      // restore rather than a scoped one.
      if (state.previousCallerId === undefined) {
        state.store.delete(CALLER_METADATA_KEY);
      } else {
        state.store.set(CALLER_METADATA_KEY, state.previousCallerId);
      }
    }

    this.operationTraceRegistry.internalEndTraceStep(
      state.traceId,
      `${state.className}#${state.methodKey}`,
      state.className,
      state.methodKey,
      state.spanId,
      this.toSpanError(ctx.errors),
    );

    if (state.ownsTrace) {
      this.endOperationTrace(state.traceId, state.context);
    }
  }

  /**
   * The common case: the operation arrived over an HTTP request the HTTP agent
   * already opened a trace for. The operation becomes a root span in that trace
   * and lends it its operation id; the HTTP response hook still owns ending and
   * shipping the snapshot.
   */
  private startWithinRequest(
    traceId: string,
    operationId: string,
    attributes: RequestSnapshot["attributes"],
    info: GraphQLResolveInfoLike,
    ctx: GqlRequestStartContext,
  ): OperationState | undefined {
    this.applyAttributes(info, ctx.context);
    this.operationTraceRegistry.addGraphQLMetadataToTrace(traceId, {
      operationId,
      tags: this.options.graphql?.tags,
      attributes,
    });
    return this.openSpan(traceId, info, ctx, false);
  }

  /**
   * No enclosing trace - any transport with no agent of its own in front of it.
   * The operation is the whole trace here, so this opens it, samples it, and
   * ships the snapshot itself.
   *
   * The store is installed with `enterWith` rather than `run`, because a hook
   * that returns cannot wrap the work that follows it. That makes this a
   * best-effort path, and the way it can be wrong is worth naming: `enterWith`
   * binds the store to the driver's *current* execution context and everything
   * continuing from it, so where that context is shared between operations -
   * rather than created per request, as an HTTP transport does - one
   * operation's spans can be recorded against another's trace. In a service
   * handling several tenants' operations that is telemetry attributed to the
   * wrong one, not merely a trace with the wrong shape.
   *
   * There is no fix available at this layer, and pretending otherwise would be
   * worse than the risk: the caller has already established that no enclosing
   * trace exists, so there is nothing here to defend against, and the leak is
   * outward rather than inward. Closing it needs the GraphQL driver to offer a
   * hook that *wraps* execution - which `run` could then scope exactly - rather
   * than one that returns into it. Until then, a deployment that cares should
   * put a transport agent in front: the HTTP path never takes this branch.
   */
  private startAsOperation(
    operationId: string,
    attributes: RequestSnapshot["attributes"],
    info: GraphQLResolveInfoLike,
    ctx: GqlRequestStartContext,
  ): OperationState | undefined {
    const shouldCapture = this.traceSamplerService.shouldCapture("graphql", {
      operationId,
    });
    if (!shouldCapture) {
      return undefined;
    }

    const traceId = this.options.traceIdGenerator(info);
    const store = new Map<KeyOf<Store>, any>();
    store.set(this.options.traceIdKey, traceId);
    this.asyncLocalStorage.enterWith(store);

    this.applyAttributes(info, ctx.context);

    this.operationTraceRegistry.startTrace(traceId, {
      protocol: GRAPHQL_PROTOCOL,
      operationId,
      tags: this.options.graphql?.tags,
      attributes,
    });

    return this.openSpan(traceId, info, ctx, true);
  }

  /**
   * Opens the span and registers it as the caller in the async store, which is
   * what makes everything the operation reaches - instrumented providers,
   * manual spans, forwarded log lines - hang underneath this node rather than
   * beside it.
   */
  private openSpan(
    traceId: string,
    info: GraphQLResolveInfoLike,
    ctx: GqlRequestStartContext,
    ownsTrace: boolean,
  ): OperationState | undefined {
    // The resolver class that registered the field, so the span groups under
    // `OrdersResolver` rather than the schema's `Query`/`Mutation`. The schema
    // type remains the fallback for a field no decorated class claims - a
    // schema-first resolver map, or a field served by a plugin.
    const handler = this.lookupResolverHandler(
      info.parentType.name,
      info.fieldName,
    );
    const className = handler?.className ?? info.parentType.name;
    const methodKey = handler?.methodKey ?? info.fieldName;

    const store = this.asyncLocalStorage.getStore();
    const previousCallerId = store?.get(CALLER_METADATA_KEY) as
      | string
      | undefined;

    const spanId = this.operationTraceRegistry.internalStartTraceStep(
      traceId,
      className,
      methodKey,
      previousCallerId,
    );
    if (!spanId) {
      // The trace was sampled out, or never started - an HTTP request that
      // `http.ignore` dropped still carries a trace id in its store. Nothing to
      // close, so the end hook is told to stand down.
      return undefined;
    }

    store?.set(CALLER_METADATA_KEY, spanId);

    return {
      traceId,
      spanId,
      className,
      methodKey,
      previousCallerId,
      store: store as Map<string, unknown> | undefined,
      ownsTrace,
      context: ctx.context,
    };
  }

  /**
   * Ends and ships a trace this service opened itself.
   *
   * No status code is passed: GraphQL has none. An operation that errored is
   * classified from its root span instead, which is what keeps a failing
   * operation out of the success bucket.
   */
  private endOperationTrace(traceId: string, context: unknown): void {
    setTimeout(async () => {
      const userId = this.options.graphql?.getUserId?.(context);
      this.operationTraceRegistry.endTrace(traceId, { userId });

      const snapshot = await this.operationTraceRegistry.pluckSnapshot(traceId);
      if (!snapshot) {
        return;
      }
      this.observeAgentSharedBuffer.insertRequestSnapshot(
        snapshot as RequestSnapshot,
      );
    }, 0);
  }

  /**
   * Picks the error a failed operation is recorded with.
   *
   * The first one wins - a span carries one error, and a document with several
   * failing fields has to pick. `originalError` is preferred over the
   * `GraphQLError` wrapping it, because that is the error the registry
   * classifies: an `IntrinsicException` a handler raised on purpose reads as
   * handled, and it stops being recognisable once GraphQL has wrapped it.
   */
  private toSpanError(
    errors: GqlRequestEndContext["errors"],
  ): Error | string | object | undefined {
    const [first] = errors ?? [];
    if (!first) {
      return undefined;
    }
    return (first.originalError as Error | undefined) ?? first;
  }

  private lookupResolverHandler(
    rootTypeName: string,
    fieldName: string,
  ): ResolverHandler | undefined {
    this.resolverIndex ??= this.buildResolverIndex();
    return this.resolverIndex.get(`${rootTypeName}.${fieldName}`);
  }

  /**
   * Walks every provider for methods `@Query`/`@Mutation`/`@Subscription`
   * decorated, and records which class hosts each root field. Read from the
   * prototypes' decorator metadata rather than the schema, because the schema
   * only knows the field - the class that registered it is exactly what it
   * erases, and what the services page wants back.
   */
  private buildResolverIndex(): Map<string, ResolverHandler> {
    const index = new Map<string, ResolverHandler>();

    for (const wrapper of this.discoveryService.getProviders()) {
      const metatype = wrapper.metatype as
        | (new (...args: never[]) => unknown)
        | undefined;
      const prototype: Record<string, unknown> | undefined = wrapper.instance
        ? Object.getPrototypeOf(wrapper.instance)
        : typeof metatype === "function"
          ? metatype.prototype
          : undefined;
      if (!prototype) {
        continue;
      }

      const className = wrapper.instance?.constructor?.name ?? metatype?.name;
      if (!className) {
        continue;
      }

      for (const methodKey of this.metadataScanner.getAllMethodNames(
        prototype,
      )) {
        const method = prototype[methodKey];
        if (typeof method !== "function") {
          continue;
        }
        const rootTypeName = Reflect.getMetadata(
          RESOLVER_TYPE_METADATA,
          method,
        ) as string | undefined;
        if (!rootTypeName || !ROOT_TYPE_NAMES.has(rootTypeName)) {
          // Not a root-field method. `@ResolveField` methods land here too:
          // they carry a name but no root type, and the operation span never
          // needs them.
          continue;
        }
        const fieldName =
          (Reflect.getMetadata(RESOLVER_NAME_METADATA, method) as
            | string
            | undefined) ?? methodKey;
        index.set(`${rootTypeName}.${fieldName}`, { className, methodKey });
      }
    }

    return index;
  }

  private applyAttributes(
    info: GraphQLResolveInfoLike,
    context: unknown,
  ): void {
    if (!this.options.graphql?.setAttributes) {
      return;
    }
    const store = this.asyncLocalStorage.getStore();
    if (!store) {
      return;
    }
    const attributes = this.options.graphql.setAttributes(info, context);
    if (!attributes) {
      return;
    }
    for (const [key, value] of Object.entries(attributes)) {
      store.set(key, value);
    }
  }
}
