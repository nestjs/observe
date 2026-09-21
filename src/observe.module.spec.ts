import type { FactoryProvider } from "@nestjs/common";
import type {
  ObserveOptions,
  ObserveOptionsFactory,
} from "./interfaces/observe-options.interface.js";
import { Test } from "@nestjs/testing";
import { createObserveModule } from "./observe.module.js";
import { OBSERVE_OPTIONS } from "./observe.constants.js";
import { DEFAULT_SPAN_COLLAPSE } from "./services/collapse-repeated-spans.util.js";
import { OperationTraceRegistry } from "./services/operation-trace.registry.js";
import { LogRedactor } from "./utils/log-redactor.js";

/**
 * The instance decorator handed to NestFactory. Bootstrap passes *every*
 * provider through it, including ones this module knows nothing about, so the
 * cases here are about surviving hostile instances rather than tracing.
 */
describe("createObserveModule#ObserveInstrument", () => {
  const decoratorOf = (instrument: unknown): ((instance: unknown) => unknown) =>
    (instrument as { instanceDecorator: (instance: unknown) => unknown })
      .instanceDecorator;

  /**
   * Shaped like a nestjs-cls proxy provider: every trap throws when touched
   * outside a CLS context - and bootstrap is always outside one.
   */
  const throwingProxyProvider = () =>
    new Proxy(
      {},
      {
        get: () => {
          throw new Error(
            "Cannot access the property on the Proxy provider because the value does not exist in the CLS.",
          );
        },
        getPrototypeOf: () => {
          throw new Error(
            "Cannot access the prototype of the Proxy provider because the value does not exist in the CLS.",
          );
        },
      },
    );

  it("leaves a provider whose inspection throws untouched", () => {
    const { ObserveInstrument } = createObserveModule();
    const provider = throwingProxyProvider();

    // Reading `decorate` (the structural ResolverDecoratorHost check) or the
    // prototype (`instanceof`) on this provider throws; bootstrap must not.
    expect(decoratorOf(ObserveInstrument)(provider)).toBe(provider);
  });

  describe("against a Nest release without the microservice dispatch hook", () => {
    // Trace-id propagation over a microservice client uses
    // `ClientProxy#setOnDispatchHook`, which only newer Nest releases have.
    // The SDK's floor is older than that, so its absence has to be the
    // ordinary case - nothing thrown, nothing logged, the client untouched -
    // and never a reason a supported application fails to boot.
    class LegacyClientProxy {
      sent: unknown[] = [];
      send(pattern: string, data: unknown) {
        this.sent.push({ pattern, data });
        return "sent";
      }
    }

    it("leaves a client that has no such hook exactly as it found it", () => {
      const { ObserveInstrument } = createObserveModule();
      const client = new LegacyClientProxy();
      const before = Object.getOwnPropertyNames(client).sort();

      const decorated = decoratorOf(ObserveInstrument)(
        client,
      ) as LegacyClientProxy;

      expect(Object.getOwnPropertyNames(client).sort()).toEqual(before);
      expect(decorated.send("orders.report", { id: 1 })).toBe("sent");
      expect(client.sent).toEqual([
        { pattern: "orders.report", data: { id: 1 } },
      ]);
    });

    it("uses the hook where the framework provides one", () => {
      const { ObserveInstrument } = createObserveModule();
      const setOnDispatchHook = vi.fn();

      decoratorOf(ObserveInstrument)({ setOnDispatchHook });

      expect(setOnDispatchHook).toHaveBeenCalledOnce();
      // And a hook run outside any trace adds nothing to the packet.
      const [hook] = setOnDispatchHook.mock.calls[0];
      const packet: { metadata?: unknown } = {};
      hook(packet);
      expect(packet.metadata).toBeUndefined();
    });
  });

  it("excludes providers via the skipInstrumentation option", () => {
    class OptedOutService {
      run() {}
    }
    const { ObserveInstrument } = createObserveModule({
      skipInstrumentation: (instance) => instance instanceof OptedOutService,
    });
    const decorate = decoratorOf(ObserveInstrument);
    const optedOut = new OptedOutService();
    const other = { run() {} };

    expect(decorate(optedOut)).toBe(optedOut);
    // The hook only excludes what it matches - everything else still gets its
    // instrumentation proxy.
    expect(decorate(other)).not.toBe(other);
  });

  it("carries no extra properties besides the decorator", () => {
    // `instanceDecorator` is the framework's whole contract
    // (nestjs/nest#17559 dropped a separate skip hook to avoid duplicating
    // APIs) - exclusions are the decorator's own business.
    const { ObserveInstrument } = createObserveModule();

    expect(Object.keys(ObserveInstrument as object)).toEqual([
      "instanceDecorator",
    ]);
  });

  it("treats a skipInstrumentation hook that throws as an exclusion", () => {
    const { ObserveInstrument } = createObserveModule({
      skipInstrumentation: () => {
        throw new Error("user hook exploded");
      },
    });
    const instance = { run() {} };

    expect(decoratorOf(ObserveInstrument)(instance)).toBe(instance);
  });
});

/**
 * The `forRootAsync` wiring, which has three mutually exclusive shapes and one
 * invalid one. The providers are built by plain static methods, so these assert
 * on what those return rather than booting an application - the protocol
 * integration suites already cover a module that actually starts.
 */
describe("createObserveModule#forRootAsync", () => {
  const { ObserveModule } = createObserveModule();

  const optionsOf = (provider: unknown) => provider as FactoryProvider;

  // Returned as a loose bag rather than `ObserveOptions`: the assertions below
  // reach for the defaults `createObserveModule` merges in, which live on
  // `ObserveModuleOptionsWithDefaults` rather than on the options a caller
  // supplies.
  const resolve = async (
    provider: unknown,
    ...args: unknown[]
  ): Promise<Record<string, unknown>> =>
    (await optionsOf(provider).useFactory(...args)) as Record<string, unknown>;

  const observeOptions = (): ObserveOptions =>
    ({
      appKey: "key",
      appSecret: "secret",
      serviceId: "svc",
    }) as ObserveOptions;

  describe("useFactory", () => {
    it("resolves the options through the factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: () => observeOptions(),
      });

      expect(optionsOf(provider).provide).toBe(OBSERVE_OPTIONS);
      await expect(resolve(provider)).resolves.toMatchObject({
        appKey: "key",
        serviceId: "svc",
      });
    });

    it("awaits an async factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: async () => observeOptions(),
      });

      await expect(resolve(provider)).resolves.toMatchObject({
        appSecret: "secret",
      });
    });

    it("keeps the module defaults the factory did not override", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: () => observeOptions(),
      });

      // `traceIdKey` and friends are defaulted by `createObserveModule`, and the
      // async path has to carry them through - forgetting to would leave every
      // trace id written under `undefined`.
      const resolved = await resolve(provider);
      expect(resolved.traceIdKey).toBe("traceId");
      expect(resolved.attachTraceIdToLogs).toBe(true);
    });

    it("passes the declared dependencies through to the factory", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useFactory: (config: { serviceId: string }) =>
          ({
            ...observeOptions(),
            serviceId: config.serviceId,
          }) as ObserveOptions,
        inject: ["CONFIG"],
      });

      expect(optionsOf(provider).inject).toEqual(["CONFIG"]);
      await expect(
        resolve(provider, { serviceId: "from-config" }),
      ).resolves.toMatchObject({ serviceId: "from-config" });
    });
  });

  describe("useClass", () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions(): ObserveOptions {
        return observeOptions();
      }
    }

    it("registers the factory class alongside the options provider", () => {
      const providers = ObserveModule.createAsyncProviders({
        useClass: ObserveConfig,
      });

      // Two providers: the options themselves, and the class that produces them
      // - which nothing else in the graph would otherwise instantiate.
      expect(providers).toHaveLength(2);
      expect(providers[1]).toEqual({
        provide: ObserveConfig,
        useClass: ObserveConfig,
      });
    });

    it("resolves the options through createObserveOptions", async () => {
      const [provider] = ObserveModule.createAsyncProviders({
        useClass: ObserveConfig,
      });

      expect(optionsOf(provider).inject).toEqual([ObserveConfig]);
      await expect(
        resolve(provider, new ObserveConfig()),
      ).resolves.toMatchObject({ appKey: "key", serviceId: "svc" });
    });

    it("awaits a factory class that resolves asynchronously", async () => {
      class AsyncObserveConfig implements ObserveOptionsFactory {
        async createObserveOptions(): Promise<ObserveOptions> {
          return observeOptions();
        }
      }
      const [provider] = ObserveModule.createAsyncProviders({
        useClass: AsyncObserveConfig,
      });

      await expect(
        resolve(provider, new AsyncObserveConfig()),
      ).resolves.toMatchObject({ appSecret: "secret" });
    });
  });

  describe("useExisting", () => {
    class ObserveConfig implements ObserveOptionsFactory {
      createObserveOptions(): ObserveOptions {
        return observeOptions();
      }
    }

    it("injects the existing provider without registering it again", async () => {
      const providers = ObserveModule.createAsyncProviders({
        useExisting: ObserveConfig,
      });

      // One provider only: the class is already in the graph, and registering a
      // second copy would give the module a different instance than the rest of
      // the application shares.
      expect(providers).toHaveLength(1);
      expect(optionsOf(providers[0]).inject).toEqual([ObserveConfig]);
      await expect(
        resolve(providers[0], new ObserveConfig()),
      ).resolves.toMatchObject({ serviceId: "svc" });
    });
  });

  describe("with none of the three", () => {
    it("says which options are missing instead of failing at injection time", () => {
      // Nest would otherwise try to resolve `undefined` as a token and fail much
      // later, with nothing pointing back at the module's configuration.
      expect(() => ObserveModule.createAsyncProviders({})).toThrow(
        /requires one of "useFactory", "useClass" or "useExisting"/,
      );
      expect(() => ObserveModule.createAsyncOptionsProvider({})).toThrow(
        /requires one of "useFactory", "useClass" or "useExisting"/,
      );
    });
  });
});

/**
 * The registry is built before the container exists, so `spanCollapse` can
 * only reach it through the provider that hands it to the container. These
 * boot a real module for each configuration shape and read the settings back
 * off the instance the container resolved.
 */
describe("createObserveModule#spanCollapse wiring", () => {
  const credentials = { appKey: "key", appSecret: "secret", serviceId: "svc" };

  const settingsOf = (registry: OperationTraceRegistry) =>
    (registry as unknown as { spanCollapse: unknown }).spanCollapse;

  const bootWith = async (module: unknown) => {
    const moduleRef = await Test.createTestingModule({
      imports: [module as never],
    }).compile();
    return moduleRef.get(OperationTraceRegistry, { strict: false });
  };

  it("applies the defaults when forRoot names nothing", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(ObserveModule.forRoot(credentials));

    expect(settingsOf(registry)).toEqual(DEFAULT_SPAN_COLLAPSE);
  });

  it("passes forRoot settings through to the registry", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(
      ObserveModule.forRoot({
        ...credentials,
        spanCollapse: { threshold: 50, keepSlowest: 5 },
      }),
    );

    expect(settingsOf(registry)).toEqual({ threshold: 50, keepSlowest: 5 });
  });

  it("switches collapsing off through forRoot", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(
      ObserveModule.forRoot({ ...credentials, spanCollapse: false }),
    );

    expect(settingsOf(registry)).toBeUndefined();
  });

  it("waits for asynchronously resolved options", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(
      ObserveModule.forRootAsync({
        useFactory: async () => ({
          ...credentials,
          spanCollapse: { threshold: 7, keepSlowest: 1 },
        }),
      }),
    );

    expect(settingsOf(registry)).toEqual({ threshold: 7, keepSlowest: 1 });
  });
});

/**
 * Same arrangement for `redaction`: the registry redacts error payloads with
 * its own defaults from construction, and the provider is where the options a
 * deployment configured replace them - or switch them off.
 */
describe("createObserveModule#redaction wiring", () => {
  const credentials = { appKey: "key", appSecret: "secret", serviceId: "svc" };

  const redactorOf = (registry: OperationTraceRegistry) =>
    (registry as unknown as { redactor: LogRedactor | null }).redactor;

  const bootWith = async (module: unknown) => {
    const moduleRef = await Test.createTestingModule({
      imports: [module as never],
    }).compile();
    return moduleRef.get(OperationTraceRegistry, { strict: false });
  };

  it("redacts with the defaults when forRoot names nothing", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(ObserveModule.forRoot(credentials));

    expect(redactorOf(registry)?.redactMessage("password=x")).toBe(
      "password=[REDACTED]",
    );
  });

  it("passes forRoot settings through to the registry", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(
      ObserveModule.forRoot({
        ...credentials,
        redaction: { replacement: "***" },
      }),
    );

    expect(redactorOf(registry)?.redactMessage("password=x")).toBe(
      "password=***",
    );
  });

  it("switches redaction off through forRoot", async () => {
    const { ObserveModule } = createObserveModule();

    const registry = await bootWith(
      ObserveModule.forRoot({ ...credentials, redaction: { enabled: false } }),
    );

    expect(redactorOf(registry)).toBeNull();
  });
});
