import { Logger } from "@nestjs/common";
import { Metadata } from "@grpc/grpc-js";
import {
  GrpcMethodStreamingType,
  Server,
  ServerGrpc,
  ServerKafka,
  ServerTCP,
  TcpContext,
  Transport,
} from "@nestjs/microservices";
import { context as otelContext, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { AsyncLocalStorage } from "async_hooks";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { concatMap, Observable } from "rxjs";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { createInstanceDecorator } from "../instrument/create-instance-decorator.instrument.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { TRACE_CONTEXT_KEY, TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { TracerService } from "../services/tracer.service.js";
import { nestMajor } from "../testing/nest-version.js";
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
    // From the constructor: Nest announces a server as it builds the
    // microservice, before the application is handed it.
    createAgent(subscribe);

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
    let agent: ReturnType<typeof createAgent> | undefined;

    expect(() => {
      agent = createAgent(subscribe);
    }).not.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
    expect(() => agent!.onModuleDestroy()).not.toThrow();
  });

  it("starts even when the target registry cannot be subscribed to", () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    expect(() =>
      createAgent(() => {
        throw new Error("no registry");
      }),
    ).not.toThrow();
  });

  describe("getOperationIdFromContext", () => {
    const getOperationId = (ctx: unknown, target?: unknown): string => {
      const agent = createAgent(() => ({ unsubscribe: vi.fn() }));
      return (
        agent as unknown as {
          getOperationIdFromContext: (ctx: unknown, target?: unknown) => string;
        }
      ).getOperationIdFromContext(ctx, target);
    };

    /** A TCP message as Nest delivers it, its pattern as the sender wrote it. */
    const tcpMessage = (pattern: string) =>
      new TcpContext([{} as never, pattern]);

    it("names a TCP message by the route its handler is registered under", () => {
      const server = new ServerTCP({});
      server.addHandler({ cmd: "sum" }, async () => 1);

      for (const spelling of [
        '{"cmd":"sum"}',
        '{ "cmd" : "sum" }',
        '{"cmd":"refund","cmd":"sum"}',
        '{"cmd":"s\\u0075m"}',
      ]) {
        expect(getOperationId(tcpMessage(spelling), server)).toBe(
          '{"cmd":"sum"}',
        );
      }
    });

    it("keeps the text of a message the server cannot be asked about", () => {
      const spelling = '{ "cmd" : "sum" }';
      const throwing = {
        getHandlers: () => {
          throw new Error("not a server");
        },
      } as unknown as Server;

      expect(getOperationId(tcpMessage(spelling))).toBe(spelling);
      expect(getOperationId(tcpMessage(spelling), throwing)).toBe(spelling);
      expect(getOperationId(tcpMessage(spelling), new ServerTCP({}))).toBe(
        spelling,
      );
    });

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
          // Asked by the end hook, which runs once the handler settles -
          // since 12.0.4, when it fails too.
          hasTrace: vi.fn(() => false),
        } as never,
        {} as never,
        { shouldCapture: () => overrides.capture ?? true } as never,
      );
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
          // Let any timer fire, so an extra call would count.
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(done).toHaveBeenCalledTimes(2);
        },
      );

      it.each([
        ["traced", {}],
        ["ignored", { ignore: true }],
        ["sampled out", { capture: false }],
      ])(
        "has run done by the time it returns when the operation is %s",
        (_operation, overrides) => {
          // Nest listens for a gRPC call's `cancelled` and `end` inside done,
          // and grpc-js emits `cancelled` once: a call whose deadline expired
          // on arrival, run a tick later, left a client-streaming handler
          // waiting on a request stream that never ended.
          const startHook = captureStartHook(createHookedAgent(overrides));
          const done = vi.fn(async () => "handled");

          void startHook(transportId, {}, done);

          expect(done).toHaveBeenCalledOnce();
        },
      );
    });

    it("runs the handler of a custom transporter that names no transport, traced as custom", async () => {
      // `transportId` is optional on `Server` and `CustomTransportStrategy`,
      // and Nest hands the hooks what the server has.
      const startTrace = vi.fn();
      const sampledAs: unknown[] = [];
      const agent = new RpcObserveAgentService(
        new AsyncLocalStorage<Map<string, any>>(),
        {
          traceIdKey: "traceId",
          traceIdGenerator: () => "trace-id",
          rpc: {},
        } as never,
        {
          getRpcTargetRegistry: () => ({
            subscribe: () => ({ unsubscribe: vi.fn() }),
          }),
        } as never,
        { startTrace, hasTrace: () => false } as never,
        {} as never,
        {
          shouldCapture: (_protocol: string, ctx: { transport: unknown }) => {
            sampledAs.push(ctx.transport);
            return true;
          },
        } as never,
      );
      let endHook!: (transportId: undefined, ctx: unknown) => void;
      let startHook!: (
        transportId: undefined,
        ctx: unknown,
        done: () => Promise<unknown>,
      ) => unknown;
      agent.registerRpcHooks({
        setOnProcessingStartHook: (hook: typeof startHook) => {
          startHook = hook;
        },
        setOnProcessingEndHook: (hook: typeof endHook) => {
          endHook = hook;
        },
      } as never);
      const ctx = { getPattern: () => "orders.paid" };

      await expect(
        Promise.resolve(startHook(undefined, ctx, async () => "handled")),
      ).resolves.toBe("handled");
      expect(() => endHook(undefined, ctx)).not.toThrow();

      expect(sampledAs).toEqual(["Symbol(custom)"]);
      expect(startTrace).toHaveBeenCalledOnce();
      expect(startTrace.mock.calls[0][1]).toMatchObject({
        protocol: "custom",
        operationId: "orders.paid",
      });
    });

    /**
     * With `openTelemetry` on, a TCP or Redis message carries W3C trace
     * context in its metadata beside the trace id, and its handler runs in it
     * for an OpenTelemetry SDK in this process.
     */
    describe("W3C trace context sent with a message", () => {
      // The W3C spec's own example, and the id Observe writes it as.
      const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
      const TRACE_ID_AS_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
      const SPAN_ID = "00f067aa0ba902b7";
      const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

      beforeEach(() => {
        otelContext.setGlobalContextManager(
          new AsyncLocalStorageContextManager().enable(),
        );
      });

      afterEach(() => {
        otelContext.disable();
      });

      /** What the agent's trace registry is asked, for the cases that read it. */
      const registryOf = () => ({
        startTrace: vi.fn(),
        endTrace: vi.fn(),
        pluckSnapshot: vi.fn(),
        hasTrace: vi.fn(() => false),
      });

      const startHookFor = (
        openTelemetry: boolean | undefined,
        reporting = true,
        overrides: { ignore?: boolean; capture?: boolean } = {},
        registry = registryOf(),
        als = new AsyncLocalStorage<Map<string, any>>(),
      ) => {
        const agent = new RpcObserveAgentService(
          als,
          {
            traceIdKey: "traceId",
            // What the default makes of the id the sending agent attached.
            traceIdGenerator: () => TRACE_ID_AS_UUID,
            openTelemetry,
            rpc: { ignore: () => overrides.ignore ?? false },
          } as never,
          {
            getRpcTargetRegistry: () => ({
              subscribe: () => ({ unsubscribe: vi.fn() }),
            }),
          } as never,
          registry as never,
          { isReporting: () => reporting } as never,
          { shouldCapture: () => overrides.capture ?? true } as never,
        );
        return captureStartHook(agent);
      };

      /** The OpenTelemetry span context a message's handler ran in. */
      const handledIn = (
        startHook: ReturnType<typeof startHookFor>,
        metadata: Record<string, string> | undefined,
      ) =>
        Promise.resolve(
          startHook(Transport.TCP, { getMetadata: () => metadata }, async () =>
            trace.getSpanContext(otelContext.active()),
          ),
        );

      it.each([
        ["traced", {}],
        ["ignored", { ignore: true }],
        ["sampled out", { capture: false }],
      ])(
        "runs the handler of a %s message in the trace it was sent in",
        async (_, overrides) => {
          const startHook = startHookFor(true, true, overrides);

          await expect(
            handledIn(startHook, {
              "x-request-id": TRACE_ID_AS_UUID,
              traceparent: TRACEPARENT,
            }),
          ).resolves.toEqual({
            traceId: TRACE_ID,
            spanId: SPAN_ID,
            traceFlags: 1,
            isRemote: true,
          });
        },
      );

      it.each([
        ["openTelemetry off", undefined, true, TRACEPARENT],
        ["the agent not reporting", true, false, TRACEPARENT],
        [
          "a traceparent for another trace",
          true,
          true,
          `00-${"a".repeat(32)}-${SPAN_ID}-01`,
        ],
        ["no traceparent", true, true, undefined],
      ])(
        "runs the handler in no trace with %s",
        async (_, openTelemetry, reporting, traceparent) => {
          const startHook = startHookFor(openTelemetry, reporting);

          await expect(
            handledIn(
              startHook,
              traceparent === undefined ? undefined : { traceparent },
            ),
          ).resolves.toBeUndefined();
        },
      );

      const SENT_IN = {
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        sampled: true,
      };

      it("puts the handler's span under the span that sent the message, and carries that context in its store", async () => {
        const registry = registryOf();
        const als = new AsyncLocalStorage<Map<string, any>>();
        const startHook = startHookFor(true, true, {}, registry, als);

        const stored = await Promise.resolve(
          startHook(
            Transport.TCP,
            {
              getMetadata: () => ({
                "x-request-id": TRACE_ID_AS_UUID,
                traceparent: TRACEPARENT,
              }),
            },
            async () => als.getStore()?.get(TRACE_CONTEXT_KEY),
          ),
        );

        expect(stored).toEqual(SENT_IN);
        expect(registry.startTrace.mock.calls[0][3]).toEqual(SENT_IN);
      });

      it("records no context for a message sent unsampled, by an operation the sender was not recording", async () => {
        const registry = registryOf();
        const startHook = startHookFor(true, true, {}, registry);

        await handledIn(startHook, {
          "x-request-id": TRACE_ID_AS_UUID,
          traceparent: `00-${TRACE_ID}-${SPAN_ID}-00`,
        });

        expect(registry.startTrace.mock.calls[0][3]).toBeUndefined();
      });

      it("puts a gRPC call's span under the caller's, read off the call's metadata", async () => {
        const registry = registryOf();
        const als = new AsyncLocalStorage<Map<string, any>>();
        const startHook = startHookFor(true, true, {}, registry, als);
        const call = {
          request: {},
          operationId: "FindOne",
          metadata: {
            get: (key: string) => (key === "traceparent" ? [TRACEPARENT] : []),
          },
        };

        const stored = await Promise.resolve(
          startHook(Transport.GRPC, call, async () =>
            als.getStore()?.get(TRACE_CONTEXT_KEY),
          ),
        );

        expect(stored).toEqual(SENT_IN);
        expect(registry.startTrace.mock.calls[0][3]).toEqual(SENT_IN);
      });
    });

    // Nest 11's ServerKafka loads kafkajs as it is constructed, Nest 12's only
    // once it listens - so before 12 this needs kafkajs installed.
    const itWithServerKafka = it.runIf(
      nestMajor >= 12 || isInstalled("kafkajs"),
    );

    itWithServerKafka(
      "lets a Kafka consumer see an event handler's failure",
      async () => {
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
      },
    );
  });

  /**
   * A gRPC request stream's messages are emitted on the call, which Nest's
   * start hook is handed only a copy of, and every message after those queued
   * when the handler subscribes comes from grpc-js's connection callback, in
   * no store. Run through Nest's own `ServerGrpc`, with a stream standing in
   * for grpc-js's call.
   */
  describe("gRPC request streams", () => {
    class FakeCall extends Duplex {
      readonly metadata = new Metadata();
      cancelled = false;
      readonly written: unknown[] = [];

      constructor() {
        super({ objectMode: true });
      }

      override _read(): void {}

      override _write(
        chunk: unknown,
        _encoding: string,
        callback: () => void,
      ): void {
        this.written.push(chunk);
        callback();
      }
    }

    beforeEach(() => {
      // No provider is instrumented here, which the registry says aloud for
      // every call that ends.
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    });

    function createGrpcServer(
      /** Run on the server once the agent has hooked it. */
      after?: (server: ServerGrpc) => void,
    ) {
      const als = new AsyncLocalStorage<Map<string, any>>();
      const registry = new OperationTraceRegistry(als as never, false);
      const streamOptions: ObserveModuleOptionsWithDefaults = {
        serviceId: "grpc-stream-test",
        traceIdKey: "correlationId",
        traceIdGenerator: () => "call-trace",
        attachTraceIdToLogs: false,
        skipInstrumentation: () => false,
        sourceContext: false,
        enabled: true,
        grpc: {
          setAttributes: (call) => ({
            caller: String(
              (call as { metadata: Metadata }).metadata.get("caller")[0],
            ),
          }),
        },
      };
      const snapshots: RequestSnapshot[] = [];
      const buffer = {
        insertRequestSnapshot: (snapshot: RequestSnapshot) =>
          snapshots.push(snapshot),
      } as unknown as ObserveAgentSharedBuffer;
      const agent = new RpcObserveAgentService(
        als,
        streamOptions,
        {} as never,
        registry,
        buffer,
        new TraceSamplerService(streamOptions),
      );
      const tracer = new TracerService(
        registry,
        als as never,
        buffer,
        streamOptions,
      );
      const server = new ServerGrpc({ package: "test", protoPath: "test" });
      agent.registerRpcHooks(server as never);
      after?.(server);
      const decorate = createInstanceDecorator(als, registry, {
        traceIdKey: streamOptions.traceIdKey,
        skipInstrumentation: () => false,
      });
      /** The method grpc-js would run for each call of a handler. */
      const methodFor = (
        handler: (...args: any[]) => unknown,
        streamType: GrpcMethodStreamingType,
      ) =>
        (
          server as unknown as {
            createServiceMethod: (
              handler: unknown,
              proto: { requestStream: boolean; responseStream: boolean },
              streamType: GrpcMethodStreamingType,
            ) => (call: unknown, callback?: unknown) => Promise<unknown>;
          }
        ).createServiceMethod(
          handler,
          { requestStream: true, responseStream: true },
          streamType,
        );
      /** How many traces the registry holds open. */
      const openTraces = () =>
        (registry as unknown as { traceSnapshots: Map<string, unknown> })
          .traceSnapshots.size;
      return {
        als,
        registry,
        tracer,
        snapshots,
        methodFor,
        decorate,
        openTraces,
      };
    }

    /** Lets grpc-js's callback for a later message run, in no store. */
    const later = () => new Promise((resolve) => setImmediate(resolve));

    it("handles each later message of a @GrpcStreamCall handler in the call's store", async () => {
      const { als, tracer, methodFor } = createGrpcServer();
      const seen: unknown[] = [];
      const call = new FakeCall();
      const method = methodFor(function TrackOnCall(stream: FakeCall) {
        stream.on("data", (message: { id: string }) => {
          // Throws outside a store, and nothing would catch it here.
          void tracer.createSpan(`message ${message.id}`, () => {
            seen.push([message.id, tracer.currentTraceId()]);
          });
        });
      }, GrpcMethodStreamingType.PT_STREAMING);

      await method(call);
      for (const id of ["1", "2", "3"]) {
        await later();
        expect(als.getStore()).toBeUndefined();
        call.push({ id });
      }
      await later();

      expect(seen).toEqual([
        ["1", "call-trace"],
        ["2", "call-trace"],
        ["3", "call-trace"],
      ]);
    });

    it("handles each later message of a @GrpcStreamMethod handler in the call's store", async () => {
      const { tracer, methodFor } = createGrpcServer();
      const call = new FakeCall();
      const method = methodFor(function Track(
        messages: Observable<{ id: string }>,
      ) {
        // A rejected span fails the call with status 2.
        return messages.pipe(
          concatMap((message) =>
            tracer.createSpan(`message ${message.id}`, () => ({
              id: message.id,
              traceId: tracer.currentTraceId(),
            })),
          ),
        );
      }, GrpcMethodStreamingType.RX_STREAMING);

      void method(call);
      for (const id of ["1", "2", "3"]) {
        await later();
        call.push({ id });
      }
      await waitFor(() => call.written.length === 3, 2000, "three answers");

      expect(call.written).toEqual([
        { id: "1", traceId: "call-trace" },
        { id: "2", traceId: "call-trace" },
        { id: "3", traceId: "call-trace" },
      ]);
    });

    it("keeps two open streams in their own calls", async () => {
      const { tracer, methodFor } = createGrpcServer();
      const seen: unknown[] = [];
      const method = methodFor(function TrackOnCall(stream: FakeCall) {
        stream.on("data", (message: { from: string }) => {
          seen.push([message.from, tracer.getAttribute("caller" as never)]);
        });
      }, GrpcMethodStreamingType.PT_STREAMING);
      const calls = ["a", "b"].map((caller) => {
        const call = new FakeCall();
        call.metadata.set("caller", caller);
        return call;
      });

      for (const call of calls) {
        await method(call);
      }
      await later();
      calls[1].push({ from: "b" });
      calls[0].push({ from: "a" });
      await later();

      expect(seen).toEqual([
        ["b", "b"],
        ["a", "a"],
      ]);
    });

    /** What grpc-js does to a call on a deadline or a client's cancellation. */
    const cancel = (call: FakeCall) => {
      call.cancelled = true;
      call.emit("cancelled", "cancelled");
      call.destroy();
    };

    it("drops the trace of a @GrpcStreamCall call cancelled while its handler waits for the end", async () => {
      const { decorate, methodFor, openTraces, snapshots } = createGrpcServer();
      const uploads = decorate({
        async upload(call: FakeCall) {
          await new Promise((resolve, reject) => {
            call.on("end", resolve);
            call.on("error", reject);
          });
        },
      });
      const call = new FakeCall();
      void methodFor(function Upload(stream: FakeCall) {
        return uploads.upload(stream);
      }, GrpcMethodStreamingType.PT_STREAMING)(call);
      await later();
      expect(openTraces()).toBe(1);

      cancel(call);
      // A turn for the handler to settle on `cancelled` first.
      expect(openTraces()).toBe(1);
      await later();
      await later();

      expect(openTraces()).toBe(0);
      expect(snapshots).toEqual([]);
    });

    it("reports a @GrpcStreamCall call whose handler settles on cancelled", async () => {
      const { decorate, methodFor, openTraces, snapshots } = createGrpcServer();
      const uploads = decorate({
        async upload(call: FakeCall) {
          await new Promise((resolve) => call.once("cancelled", resolve));
        },
      });
      const call = new FakeCall();
      void methodFor(function Upload(stream: FakeCall) {
        return uploads.upload(stream);
      }, GrpcMethodStreamingType.PT_STREAMING)(call);
      await later();

      cancel(call);
      await waitFor(() => snapshots.length === 1, 2000, "the upload");

      expect(snapshots[0].operationId).toBe("Upload");
      expect(openTraces()).toBe(0);
    });

    it("drops the trace of a @GrpcStreamCall call cancelled before an application's start hook let it through", async () => {
      let letThrough!: () => void;
      const { decorate, methodFor, openTraces } = createGrpcServer((server) =>
        server.setOnProcessingStartHook((_transportId, _ctx, done) => {
          letThrough = () => void done();
          return undefined;
        }),
      );
      const uploads = decorate({
        async upload(call: FakeCall) {
          await new Promise((resolve) => call.on("end", resolve));
        },
      });
      const call = new FakeCall();
      void methodFor(function Upload(stream: FakeCall) {
        return uploads.upload(stream);
      }, GrpcMethodStreamingType.PT_STREAMING)(call);

      cancel(call);
      letThrough();
      expect(openTraces()).toBe(1);
      await later();
      await later();

      expect(openTraces()).toBe(0);
    });

    it("leaves a cancelled @GrpcStreamMethod call to Nest's end hook", async () => {
      const { registry, decorate, methodFor } = createGrpcServer();
      const abandonTrace = vi.spyOn(registry, "abandonTrace");
      const orders = decorate({
        track(messages: Observable<{ id: string }>) {
          return messages;
        },
      });
      const call = new FakeCall();
      void methodFor(function Track(messages: Observable<{ id: string }>) {
        return orders.track(messages);
      }, GrpcMethodStreamingType.RX_STREAMING)(call);
      await later();

      cancel(call);
      for (let turn = 0; turn < 5; turn++) {
        await later();
      }

      expect(abandonTrace).not.toHaveBeenCalled();
    });

    it("leaves an event emitted from inside the call in the context it has", async () => {
      const { als, methodFor } = createGrpcServer();
      const seen: unknown[] = [];
      const call = new FakeCall();
      const method = methodFor(function TrackOnCall(stream: FakeCall) {
        stream.on("mark", () => seen.push(als.getStore()?.get("inner")));
      }, GrpcMethodStreamingType.PT_STREAMING);

      await method(call);
      // A context of the call's own - a span's store - with something its
      // own store does not hold.
      const store = new Map([
        [TRACE_REGISTRY_KEY, registryKeyOf(call, als)],
        ["inner", "span"],
      ]);
      als.run(store as never, () => call.emit("mark"));
      call.emit("mark");

      expect(seen).toEqual(["span", undefined]);
    });
  });
});

/** The registry key the call's events run under. */
function registryKeyOf(
  call: { emit: (event: string) => boolean; once: Function },
  als: AsyncLocalStorage<Map<string, any>>,
): unknown {
  let key: unknown;
  call.once("probe", () => {
    key = als.getStore()?.get(TRACE_REGISTRY_KEY);
  });
  call.emit("probe");
  return key;
}

function isInstalled(name: string): boolean {
  try {
    createRequire(import.meta.url).resolve(name);
    return true;
  } catch {
    return false;
  }
}
