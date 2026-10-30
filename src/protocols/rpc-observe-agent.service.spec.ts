import { ServerKafka, Transport } from "@nestjs/microservices";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { createInstanceDecorator } from "../instrument/create-instance-decorator.instrument.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { TracerService } from "../services/tracer.service.js";
import { waitFor } from "../testing/observe-harness.js";
import { RpcObserveAgentService } from "./rpc-observe-agent.service.js";

/**
 * `@nestjs/microservices` is an optional peer: the agent must hook RPC
 * targets when it is installed and stay inert - not crash the module - when
 * it is not. The loader is stubbed for the latter; the package is always
 * present in this repository's own dependencies.
 */
describe("RpcObserveAgentService", () => {
  const options = { traceIdKey: "traceId" } as never;

  const createAgent = (subscribe: (...args: unknown[]) => unknown) =>
    new RpcObserveAgentService(
      new AsyncLocalStorage<Map<string, any>>(),
      options,
      { getRpcTargetRegistry: () => ({ subscribe }) } as never,
      {} as never,
      {} as never,
      {} as never,
    );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("subscribes to the RPC target registry when @nestjs/microservices is installed", () => {
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn() }));
    const agent = createAgent(subscribe);

    agent.onModuleInit();

    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("stays inert when @nestjs/microservices is not installed", () => {
    vi.spyOn(
      RpcObserveAgentService.prototype as unknown as {
        loadMicroservices: () => unknown;
      },
      "loadMicroservices",
    ).mockReturnValue(undefined);
    const subscribe = vi.fn();
    const agent = createAgent(subscribe);

    expect(() => agent.onModuleInit()).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
    expect(() => agent.onModuleDestroy()).not.toThrow();
  });

  describe("getOperationIdFromContext", () => {
    const getOperationId = (ctx: unknown): string => {
      const agent = createAgent(() => ({ unsubscribe: vi.fn() }));
      agent.onModuleInit();
      return (
        agent as unknown as {
          getOperationIdFromContext: (ctx: unknown) => string;
        }
      ).getOperationIdFromContext(ctx);
    };

    it("falls back to getPattern for a custom transport's own context class", () => {
      expect(getOperationId({ getPattern: () => "custom.pattern" })).toBe(
        "custom.pattern",
      );
    });

    it("answers 'unknown' rather than throwing when a custom context exposes no accessor", () => {
      expect(getOperationId({})).toBe("unknown");
    });
  });

  describe.each([
    ["RPC", Transport.TCP],
    ["gRPC", Transport.GRPC],
  ] as const)("%s execution ownership", (_name, transport) => {
    function createContext() {
      const als = new AsyncLocalStorage<Map<string, any>>();
      const registry = new OperationTraceRegistry(als as never, false);
      let mode: "recorded" | "ignored" | "sampled out" | "disabled" =
        "recorded";
      const getUserId = vi.fn(() => "test-user");
      const executionOptions: ObserveModuleOptionsWithDefaults = {
        serviceId: "rpc-isolation-test",
        traceIdKey: "correlationId",
        traceIdGenerator: () => "shared-trace",
        attachTraceIdToLogs: false,
        skipInstrumentation: () => false,
        sourceContext: false,
        enabled: true,
        rpc: { ignore: () => mode === "ignored", getUserId },
        grpc: { ignore: () => mode === "ignored", getUserId },
        tracesSampleRate: () => mode !== "sampled out",
      };
      const snapshots: RequestSnapshot[] = [];
      const buffer = {
        insertRequestSnapshot: (snapshot: RequestSnapshot) =>
          snapshots.push(snapshot),
      } as unknown as ObserveAgentSharedBuffer;
      const agent = new RpcObserveAgentService(
        als,
        executionOptions,
        {} as never,
        registry,
        buffer,
        new TraceSamplerService(executionOptions),
      );
      agent.onModuleInit();
      const tracer = new TracerService(
        registry,
        als as never,
        buffer,
        executionOptions,
      );
      const decorate = createInstanceDecorator(als, registry, {
        traceIdKey: executionOptions.traceIdKey,
        skipInstrumentation: () => false,
      });
      const handler = decorate({
        async run(callback: () => Promise<void>) {
          await callback();
        },
      }) as { run(callback: () => Promise<void>): Promise<void> };
      const run = (name: string, callback: () => Promise<void>) => {
        const ctx = { getPattern: () => name, operationId: name };
        const done = async () => {
          try {
            await handler.run(callback);
          } finally {
            agent.endRpcRequestTracing(transport, ctx as never);
          }
        };
        return transport === Transport.GRPC
          ? agent.startGrpcRequestTracing(transport, ctx as never, done)
          : agent.startRpcRequestTracing(transport, ctx as never, done);
      };
      return {
        als,
        registry,
        snapshots,
        tracer,
        agent,
        options: executionOptions,
        getUserId,
        run,
        setMode(value: typeof mode) {
          mode = value;
          executionOptions.enabled = mode !== "disabled";
        },
      };
    }

    function startHttpTrace(registry: OperationTraceRegistry) {
      // An ordinary HTTP request is registered under its public trace id.
      registry.startTrace("shared-trace", {
        protocol: "http",
        operationId: "/http",
      });
      const spanId = registry.internalStartTraceStep(
        "shared-trace",
        "HttpController",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep(
        "shared-trace",
        spanId,
        "HttpController",
        "handle",
        spanId,
      );
    }

    it("claims its key before an attribute callback can reach another operation", async () => {
      const context = createContext();
      startHttpTrace(context.registry);
      let callbackKey: unknown;
      let registeredDuringCallback: boolean | undefined;
      const protocolOptions =
        transport === Transport.GRPC
          ? context.options.grpc!
          : context.options.rpc!;
      protocolOptions.setAttributes = () => {
        callbackKey = context.als.getStore()!.get(TRACE_REGISTRY_KEY);
        registeredDuringCallback =
          typeof callbackKey === "string" &&
          context.registry.hasTrace(callbackKey);
        context.tracer.setOperationId("must-not-rename-http");
        return {};
      };

      await context.run("rpc", async () => undefined);
      await waitFor(() => context.snapshots.length === 1, 2000, "RPC snapshot");
      context.registry.endTrace("shared-trace", { statusCode: 200 });
      const httpSnapshot = await context.registry.pluckSnapshot("shared-trace");

      // Assertions stay outside setAttributes: its safety wrapper catches
      // thrown errors, which would also swallow a failing assertion.
      expect(callbackKey).toEqual(expect.any(String));
      expect(registeredDuringCallback).toBe(false);
      expect(httpSnapshot).toMatchObject({ operationId: "/http" });
      expect(context.snapshots[0]).toMatchObject({
        traceId: "shared-trace",
        operationId: "rpc",
      });
    });

    it.each([
      ["missing", undefined],
      ["unregistered", "not-recorded"],
      ["invalid", 42],
    ] as const)(
      "does not complete a context with a %s registry key",
      async (_kind, key) => {
        const context = createContext();
        startHttpTrace(context.registry);
        const endTrace = vi.spyOn(context.registry, "endTrace");
        const pluckSnapshot = vi.spyOn(context.registry, "pluckSnapshot");
        const store = new Map<string, unknown>([
          [context.options.traceIdKey, "shared-trace"],
        ]);
        if (key !== undefined) {
          store.set(TRACE_REGISTRY_KEY, key);
        }

        vi.useFakeTimers();
        try {
          context.als.run(store, () => {
            context.agent.endRpcRequestTracing(transport, {} as never);
          });
          expect(vi.getTimerCount()).toBe(0);
          await vi.runAllTimersAsync();
          expect(context.getUserId).not.toHaveBeenCalled();
          expect(endTrace).not.toHaveBeenCalled();
          expect(pluckSnapshot).not.toHaveBeenCalled();
          expect(context.registry.hasTrace("shared-trace")).toBe(true);
          expect(context.snapshots).toHaveLength(0);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      },
    );

    it.each(["ignored", "sampled out", "disabled"] as const)(
      "keeps a %s operation out of a recorded operation sharing its id",
      async (mode) => {
        const context = createContext();
        let release!: () => void;
        let started = false;
        const finish = new Promise<void>((resolve) => {
          release = resolve;
        });
        const recorded = context.run("recorded", async () => {
          started = true;
          await finish;
        });
        try {
          await waitFor(() => started, 1000, "recorded handler to start");
          context.setMode(mode);
          await context.run("skipped", async () => {
            const skippedKey = context.als.getStore()!.get(TRACE_REGISTRY_KEY);
            expect(skippedKey).toEqual(expect.any(String));
            expect(context.registry.hasTrace(skippedKey)).toBe(false);
            expect(context.tracer.currentTraceId()).toBe("shared-trace");
            context.tracer.setOperationId("must-not-rename-recorded");
            expect((await context.tracer.activeSpan()).id).toBe("");
            await context.tracer.createSpan("not-recorded", () => undefined);
          });
        } finally {
          release();
          await recorded;
        }
        await waitFor(
          () => context.snapshots.length > 0,
          2000,
          "recorded snapshot",
        );
        expect(context.snapshots).toHaveLength(1);
        expect(context.snapshots[0]).toMatchObject({
          traceId: "shared-trace",
          operationId: "recorded",
          userId: "test-user",
        });
        expect(context.getUserId).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(context.snapshots[0].traces)).not.toContain(
          "not-recorded",
        );
      },
    );

    it("does not let a completed context rename a later operation with the same id", async () => {
      const context = createContext();
      let finishedStore!: Map<string, any>;
      await context.run("finished", async () => {
        finishedStore = context.als.getStore()!;
      });
      await waitFor(
        () => context.snapshots.length === 1,
        2000,
        "first snapshot",
      );

      await context.run("current", async () => {
        // A timer or callback created by the completed operation keeps its
        // old store. Reusing the public id must not give it the new snapshot.
        context.als.run(finishedStore, () => {
          context.tracer.setOperationId("late-rename");
        });
        expect(context.tracer.currentTraceId()).toBe("shared-trace");
      });
      await waitFor(
        () => context.snapshots.length === 2,
        2000,
        "second snapshot",
      );
      expect(context.snapshots.map((snapshot) => snapshot.operationId)).toEqual(
        ["finished", "current"],
      );
      expect(
        context.registry.hasTrace(finishedStore.get(TRACE_REGISTRY_KEY)),
      ).toBe(false);
    });

    it("isolates concurrent failures and releases each execution's registry state", async () => {
      const context = createContext();
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const keys = new Set<string>();
      const error = new Error("first execution failed");
      const operations = Array.from({ length: 20 }, (_, index) =>
        context.run(`operation.${index}`, async () => {
          keys.add(context.als.getStore()!.get(TRACE_REGISTRY_KEY));
          (await context.tracer.activeSpan()).setTag("execution", index);
          await finish;
          if (index === 0) {
            throw error;
          }
        }),
      );
      const settled = Promise.allSettled(operations);
      try {
        await waitFor(() => keys.size === 20, 2000, "all executions to start");
      } finally {
        release();
        await settled;
      }
      const results = await settled;
      expect(results[0]).toEqual({ status: "rejected", reason: error });
      expect(
        results.slice(1).every((result) => result.status === "fulfilled"),
      ).toBe(true);
      await waitFor(
        () => context.snapshots.length === 20,
        2000,
        "all snapshots",
      );
      for (const snapshot of context.snapshots) {
        const index = Number(snapshot.operationId!.split(".")[1]);
        expect(snapshot.traceId).toBe("shared-trace");
        expect(snapshot.traces).toHaveLength(1);
        expect(snapshot.traces[0].tags?.execution).toBe(index);
        expect(snapshot.error?.message).toBe(
          index === 0 ? error.message : undefined,
        );
      }
      expect([...keys].every((key) => !context.registry.hasTrace(key))).toBe(
        true,
      );
    });

    it("holds completion while a span of its own is still open", async () => {
      // Asked under any key but this execution's own, the open-span check
      // finds no trace, answers that none is open, and the trace completes in
      // a microtask with its span still running.
      const context = createContext();
      const endTrace = vi.spyOn(context.registry, "endTrace");
      let registryKey!: string;
      let spanId: string | undefined;
      await context.run("pending", async () => {
        registryKey = context.als.getStore()!.get(TRACE_REGISTRY_KEY);
        spanId = context.registry.internalStartTraceStep(
          registryKey,
          "PendingService",
          "pending",
          undefined,
        );
      });
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(endTrace).not.toHaveBeenCalled();

      context.registry.internalEndTraceStep(
        registryKey,
        spanId,
        "PendingService",
        "pending",
        spanId,
      );
      await waitFor(() => context.snapshots.length === 1, 2000, "snapshot");
      expect(JSON.stringify(context.snapshots[0].traces)).toContain(
        "PendingService",
      );
    });
  });

  /**
   * Nest's servers hand the processing start hook's result back from their
   * message handlers, and kafkajs waits on it - committing the offset once
   * `eachMessage` resolves and retrying the message when it rejects - so the
   * hook must hand back what `done` returns rather than settle on its own.
   */
  describe("processing start hook", () => {
    const createHookedAgent = (
      overrides: { ignore?: boolean; capture?: boolean } = {},
    ) => {
      const agent = new RpcObserveAgentService(
        new AsyncLocalStorage<Map<string, any>>(),
        {
          traceIdKey: "traceId",
          traceIdGenerator: () => "trace-id",
          rpc: { ignore: () => overrides.ignore ?? false },
          grpc: { ignore: () => overrides.ignore ?? false },
        } as never,
        {
          getRpcTargetRegistry: () => ({
            subscribe: () => ({ unsubscribe: vi.fn() }),
          }),
        } as never,
        {
          startTrace: vi.fn(),
          endTrace: vi.fn(),
          pluckSnapshot: vi.fn(),
        } as never,
        {} as never,
        { shouldCapture: () => overrides.capture ?? true } as never,
      );
      agent.onModuleInit();
      return agent;
    };

    const captureStartHook = (agent: ReturnType<typeof createHookedAgent>) => {
      let startHook!: (
        transportId: Transport,
        ctx: unknown,
        done: () => Promise<unknown>,
      ) => unknown;
      agent.registerRpcHooks({
        setOnProcessingStartHook: (hook: typeof startHook) => {
          startHook = hook;
        },
        setOnProcessingEndHook: vi.fn(),
      } as never);
      return startHook;
    };

    describe.each([
      ["an RPC message", Transport.TCP],
      ["a gRPC call", Transport.GRPC],
    ])("for %s", (_transport, transportId) => {
      it.each([
        ["traced", {}],
        ["ignored", { ignore: true }],
        ["sampled out", { capture: false }],
      ])(
        "returns what done returns when the operation is %s",
        async (_operation, overrides) => {
          const startHook = captureStartHook(createHookedAgent(overrides));
          const error = new Error("handler failed");
          const done = vi
            .fn<() => Promise<unknown>>()
            .mockResolvedValueOnce("handled")
            .mockRejectedValueOnce(error);

          await expect(
            Promise.resolve(startHook(transportId, {}, done)),
          ).resolves.toBe("handled");
          await expect(
            Promise.resolve(startHook(transportId, {}, done)),
          ).rejects.toBe(error);
          // gRPC calls done from a timer; let it fire so an extra call counts.
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(done).toHaveBeenCalledTimes(2);
        },
      );
    });

    it("lets a Kafka consumer see an event handler's failure", async () => {
      const server = new ServerKafka({});
      createHookedAgent().registerRpcHooks(server as never);
      const error = new Error("handler failed");
      server.addHandler(
        "orders",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw error;
        },
        true,
      );

      await expect(
        server.getMessageHandler()({
          topic: "orders",
          partition: 0,
          message: { value: Buffer.from("{}"), headers: {} },
          heartbeat: async () => undefined,
        } as never),
      ).rejects.toBe(error);
    });
  });
});
