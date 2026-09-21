import {
  DynamicModule,
  Inject,
  Logger,
  Module,
  NestApplicationOptions,
  Provider,
} from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  HttpAdapterHost,
  MetadataScanner,
  ModulesContainer,
} from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "./agent/observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./agent/observe-agent.worker.js";
import { createInstanceDecorator } from "./instrument/create-instance-decorator.instrument.js";
import {
  CreateObserveModuleOptions,
  ObserveModuleAsyncOptions,
  ObserveModuleOptionsWithDefaults,
  ObserveOptionsFactory,
  ObserveOptions,
} from "./interfaces/observe-options.interface.js";
import { CALLER_METADATA_KEY, OBSERVE_OPTIONS } from "./observe.constants.js";
import { GraphQLObserveAgentService } from "./protocols/graphql-observe-agent.service.js";
import { HttpObserveAgentService } from "./protocols/http-observe-agent.service.js";
import { OutgoingObserveAgentService } from "./outgoing/outgoing-observe-agent.service.js";
import { BullObserveAgentService } from "./protocols/bull-observe-agent.service.js";
import { QueueObserveAgentService } from "./protocols/queue-observe-agent.service.js";
import { RpcObserveAgentService } from "./protocols/rpc-observe-agent.service.js";
import { ScheduleObserveAgentService } from "./protocols/schedule-observe-agent.service.js";
import { WsObserveAgentService } from "./protocols/ws-observe-agent.service.js";
import { LoggerPatcherService } from "./services/logger-patcher.service.js";
import { NodeRuntimeMetricsService } from "./services/node-runtime-metrics.service.js";
import { resolveSpanCollapseSettings } from "./services/collapse-repeated-spans.util.js";
import { OperationTraceRegistry } from "./services/operation-trace.registry.js";
import { StdoutForwarderService } from "./services/stdout-forwarder.service.js";
import { TraceSamplerService } from "./services/trace-sampler.service.js";
import { TracerService } from "./services/tracer.service.js";
import { KeyOf } from "./types/key-of.type.js";
import { assertModuleOptions } from "./utils/assert-module-options.util.js";
import { defaultTraceIdGenerator } from "./utils/default-trace-id-generator.util.js";
import { LogRedactor } from "./utils/log-redactor.js";

/**
 * All three async providers are optional on the options type, but one of them
 * has to be there. Stating that here beats the `undefined` token Nest would
 * otherwise try to resolve, which fails much later with no mention of why.
 */
const MISSING_ASYNC_OPTIONS_PROVIDER =
  'ObserveModule.forRootAsync() requires one of "useFactory", "useClass" or "useExisting".';

export function createObserveModule<Store extends Record<string, unknown>>(
  options: CreateObserveModuleOptions = {},
) {
  options.traceIdKey ??= "traceId";
  options.attachTraceIdToLogs ??= true;
  options.traceIdGenerator ??= defaultTraceIdGenerator;
  options.skipInstrumentation ??= () => false;

  const asyncLocalStorage = new AsyncLocalStorage<Map<KeyOf<Store>, unknown>>();
  const operationTraceRegistry = new OperationTraceRegistry(
    asyncLocalStorage as AsyncLocalStorage<
      Map<
        KeyOf<{
          [CALLER_METADATA_KEY]: string;
        }>,
        any
      >
    >,
    options.sourceContext,
  );

  @Module({
    imports: [DiscoveryModule],
    providers: [
      {
        provide: "ASSERT_MODULE_OPTIONS",
        useFactory: assertModuleOptions,
        inject: [{ token: OBSERVE_OPTIONS, optional: true }],
      },
      {
        provide: AsyncLocalStorage,
        useValue: asyncLocalStorage,
      },
      {
        provide: OperationTraceRegistry,
        // The instance already exists (the instrumentation hook below holds
        // it), so this is the one moment the resolved `ObserveOptions` and the
        // registry meet: `spanCollapse` and `redaction` are applied here.
        // Optional because `ASSERT_MODULE_OPTIONS` owns the missing-options
        // error.
        useFactory: (observeOptions?: ObserveModuleOptionsWithDefaults) => {
          operationTraceRegistry.configureSpanCollapse(
            resolveSpanCollapseSettings(observeOptions?.spanCollapse),
          );
          operationTraceRegistry.configureRedaction(
            observeOptions?.redaction?.enabled === false
              ? null
              : new LogRedactor(observeOptions?.redaction),
          );
          return operationTraceRegistry;
        },
        inject: [{ token: OBSERVE_OPTIONS, optional: true }],
      },
      TracerService,
      LoggerPatcherService,
      HttpObserveAgentService,
      RpcObserveAgentService,
      // A no-op unless @nestjs/graphql is installed and registered; it claims
      // the request lifecycle hooks only when it finds them.
      GraphQLObserveAgentService,
      ObserveAgentWorker,
      ObserveAgentSharedBuffer,
      TraceSamplerService,
      NodeRuntimeMetricsService,
      // Registered unconditionally; the service itself is a no-op unless
      // `forwardLogs` is enabled, and it redacts before anything is buffered.
      StdoutForwarderService,
      QueueObserveAgentService,
      // A no-op unless bull - the driver behind @nestjs/bull - is installed.
      BullObserveAgentService,
      // A no-op unless @nestjs/schedule is installed; it patches the explorer
      // from its constructor so the patch lands before any handler is found.
      ScheduleObserveAgentService,
      // A no-op unless @nestjs/websockets is installed.
      WsObserveAgentService,
      OutgoingObserveAgentService,
    ],
    exports: [AsyncLocalStorage, TracerService],
  })
  class ObserveModule {
    readonly logger = new Logger(ObserveModule.name);

    constructor(
      readonly httpAdapterHost: HttpAdapterHost,
      readonly asyncLocalStorage: AsyncLocalStorage<Map<KeyOf<Store>, any>>,
      @Inject(OBSERVE_OPTIONS)
      readonly options: ObserveModuleOptionsWithDefaults,
    ) {}

    static forRoot(observeOpts: ObserveOptions): DynamicModule {
      return {
        global: true,
        module: ObserveModule,
        providers: [
          {
            provide: OBSERVE_OPTIONS,
            useValue: {
              ...options,
              ...observeOpts,
            },
          },
        ],
      };
    }

    static forRootAsync(options: ObserveModuleAsyncOptions): DynamicModule {
      return {
        module: ObserveModule,
        global: options.global ?? true,
        imports: options.imports,
        providers: [
          ...this.createAsyncProviders(options),
          ...(options.extraProviders || []),
        ],
      };
    }

    static createAsyncProviders(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider[] {
      if (asyncOptions.useExisting || asyncOptions.useFactory) {
        return [this.createAsyncOptionsProvider(asyncOptions)];
      }
      const useClass = asyncOptions.useClass;
      if (!useClass) {
        throw new Error(MISSING_ASYNC_OPTIONS_PROVIDER);
      }
      return [
        this.createAsyncOptionsProvider(asyncOptions),
        {
          provide: useClass,
          useClass,
        },
      ];
    }

    static createAsyncOptionsProvider(
      asyncOptions: ObserveModuleAsyncOptions,
    ): Provider {
      const useFactory = asyncOptions.useFactory;
      if (useFactory) {
        return {
          provide: OBSERVE_OPTIONS,
          useFactory: async (...args: any[]) => {
            const opts = await useFactory(...args);
            return {
              ...options,
              ...opts,
            };
          },
          inject: asyncOptions.inject || [],
        };
      }
      const optionsFactoryToken =
        asyncOptions.useExisting ?? asyncOptions.useClass;
      if (!optionsFactoryToken) {
        throw new Error(MISSING_ASYNC_OPTIONS_PROVIDER);
      }
      return {
        provide: OBSERVE_OPTIONS,
        useFactory: async (optionsFactory: ObserveOptionsFactory) => ({
          ...options,
          ...(await optionsFactory.createObserveOptions()),
        }),
        inject: [optionsFactoryToken],
      };
    }
  }

  const skipInstrumentation = (instance: unknown): boolean => {
    try {
      return (
        // The user hook runs first so it can exclude providers whose mere
        // inspection throws before the structural checks below ever touch
        // them.
        options.skipInstrumentation!(instance) ||
        [asyncLocalStorage, operationTraceRegistry].includes(
          instance as AsyncLocalStorage<any> | OperationTraceRegistry,
        ) ||
        instance instanceof TraceSamplerService ||
        instance instanceof TracerService ||
        instance instanceof ObserveAgentSharedBuffer ||
        // Its methods run *inside* the traces it opens, so instrumenting it
        // would put a span for the agent itself at the root of every GraphQL
        // operation it records.
        instance instanceof GraphQLObserveAgentService ||
        // Same reason: its wrapper runs inside the job traces it opens.
        instance instanceof ScheduleObserveAgentService ||
        instance instanceof WsObserveAgentService ||
        instance instanceof OutgoingObserveAgentService ||
        // Nest's discovery machinery, which the GraphQL agent walks to map
        // root fields back to their resolver classes. It has to stay
        // unproxied: ModulesContainer extends Map, and a Map method invoked
        // with the instrumentation proxy as its receiver throws "called on
        // incompatible receiver" - Map's internal slots live on the target,
        // and a proxy does not forward them.
        instance instanceof ModulesContainer ||
        instance instanceof DiscoveryService ||
        instance instanceof MetadataScanner ||
        // `@nestjs/graphql`'s ResolverDecoratorHost, matched structurally
        // because the package is an optional peer. Its `onRequestStart` /
        // `onRequestEnd` methods invoke the hooks this module registers, so
        // instrumenting it would wrap the agent's own bookkeeping in spans
        // inside every operation it measures.
        isResolverDecoratorHost(instance)
      );
    } catch {
      // An instance that throws on inspection - `instanceof` runs its
      // prototype trap, `isResolverDecoratorHost` reads properties - cannot
      // be instrumented either way. nestjs-cls proxy providers are the
      // canonical case: any access outside a CLS context throws
      // ProxyProviderNotResolvedException, and instrumentation runs at
      // bootstrap, where no such context exists. Leaving the provider alone
      // is the only answer that lets the app start.
      return true;
    }
  };

  return {
    ObserveInstrument: {
      // Exclusions live entirely in the decorator: the framework's contract
      // is `instanceDecorator` alone (nestjs/nest#17559 dropped a separate
      // skip hook to avoid duplicating APIs). Newer cores additionally wrap
      // this in a safety net that falls back to the undecorated instance,
      // with a warning, should it ever throw.
      instanceDecorator: (() => {
        const decorate = createInstanceDecorator<Store>(
          asyncLocalStorage,
          operationTraceRegistry,
          {
            traceIdKey: options.traceIdKey,
            skipInstrumentation,
          },
        );
        return (instance: unknown) => {
          propagateTraceIdThrough(instance, () =>
            asyncLocalStorage.getStore()?.get(options.traceIdKey as never),
          );
          return decorate(instance as never);
        };
      })(),
    } as NestApplicationOptions["instrument"],
    ObserveModule,
  };
}

/**
 * Makes a microservice client send the current trace id with every packet.
 *
 * `setOnDispatchHook` is the client-side counterpart of the server's
 * processing hooks, and only exists on `@nestjs/microservices` versions that
 * carry packet metadata - so this is a feature test, and a no-op on every
 * version before. The id goes out under the same name an HTTP hop uses, and
 * `defaultTraceIdGenerator` reads it back from the receiving context.
 */
function propagateTraceIdThrough(
  instance: unknown,
  currentTraceId: () => unknown,
): void {
  const client = instance as {
    setOnDispatchHook?: (
      hook: (packet: { metadata?: Record<string, string> }) => void,
    ) => void;
  };
  try {
    if (typeof client?.setOnDispatchHook !== "function") {
      return;
    }
  } catch {
    // A provider whose mere inspection throws - the decorator's own
    // exclusions deal with it; it is certainly not a microservice client.
    return;
  }
  client.setOnDispatchHook((packet) => {
    const traceId = currentTraceId();
    if (typeof traceId === "string" && !packet.metadata?.["x-request-id"]) {
      packet.metadata = { ...packet.metadata, "x-request-id": traceId };
    }
  });
}

/**
 * Identifies `@nestjs/graphql`'s `ResolverDecoratorHost` without importing the
 * package, which is an optional peer. `decorate`/`setDecorator` plus the
 * request-hook accessors are its public surface and unlikely to appear together
 * on anything else.
 */
function isResolverDecoratorHost(instance: unknown): boolean {
  const candidate = instance as {
    decorate?: unknown;
    setDecorator?: unknown;
    setOnRequestStartHook?: unknown;
  };
  return (
    typeof candidate?.decorate === "function" &&
    typeof candidate.setDecorator === "function" &&
    typeof candidate.setOnRequestStartHook === "function"
  );
}
