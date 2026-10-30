import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { HttpAdapterHost } from "@nestjs/core";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { TracerService } from "../services/tracer.service.js";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { createInstanceDecorator } from "../instrument/create-instance-decorator.instrument.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { TRACE_REGISTRY_KEY } from "../observe.constants.js";
import { waitFor } from "../testing/observe-harness.js";
import { HttpObserveAgentService } from "./http-observe-agent.service.js";

describe("HttpObserveAgentService", () => {
  let startedTraces: Array<{
    traceId: string;
    data: { attributes?: { originalUrl?: string } };
    reportedTraceId?: string;
  }>;

  const createService = (
    http: ObserveModuleOptionsWithDefaults["http"] = {},
    httpAdapter: object = {
      setOnRequestHook: () => {},
      setOnResponseHook: () => {},
      setOnRouteTriggered: () => {},
    },
  ) => {
    startedTraces = [];
    const registry = {
      getRedactor: () => null,
      hasTrace: (traceId: string) =>
        startedTraces.some((started) => started.traceId === traceId),
      startTrace: (
        traceId: string,
        data: unknown,
        reportedTraceId?: string,
      ) => {
        startedTraces.push({
          traceId,
          data,
          reportedTraceId,
        } as (typeof startedTraces)[number]);
      },
    } as unknown as OperationTraceRegistry;

    return new HttpObserveAgentService(
      { httpAdapter } as unknown as HttpAdapterHost,
      new AsyncLocalStorage<Map<string, any>>(),
      {
        traceIdKey: "traceId",
        traceIdGenerator: () => "trace-1",
        http,
      } as unknown as ObserveModuleOptionsWithDefaults,
      registry,
      {} as ObserveAgentSharedBuffer,
      { shouldCapture: () => true } as unknown as TraceSamplerService,
    );
  };

  const trace = (service: HttpObserveAgentService<any>, url: string) =>
    service.startHttpRequestTracing(
      { url, method: "GET", protocol: "http" },
      {},
      () => {},
    );

  describe("an adapter without the request hooks", () => {
    it("stands aside rather than stopping the application starting", () => {
      // What every adapter before Nest 11.1.4 looks like - inside the
      // supported peer range, and a boot-time throw used to be the result.
      const warn = vi
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      try {
        let service: HttpObserveAgentService<any> | undefined;
        expect(() => {
          service = createService({}, {});
        }).not.toThrow();
        expect(() => service!.registerHttpHooks()).not.toThrow();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("11.1.4");
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe("queryParamsObfuscateRegex", () => {
    it("applies a non-global pattern instead of throwing", () => {
      // `replaceAll` refuses a non-global RegExp outright; unnormalised, this
      // threw inside the request hook and turned every traced request into a
      // 500 - while ignored health checks kept passing readiness probes.
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/,
      });

      expect(() => trace(service, "/items?internal=abc")).not.toThrow();
      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]",
      );
    });

    it("masks every occurrence, not just the first", () => {
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/,
      });

      trace(service, "/items?internal=abc&x=1&internal=def");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]&x=1&[REDACTED]",
      );
    });

    it("leaves a pattern that already has the global flag as-is", () => {
      const service = createService({
        queryParamsObfuscateRegex: /internal=\w+/g,
      });

      trace(service, "/items?internal=abc&internal=def");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?[REDACTED]&[REDACTED]",
      );
    });

    it("records the URL untouched when no pattern is configured", () => {
      const service = createService();

      trace(service, "/items?x=1");

      expect(startedTraces[0].data.attributes?.originalUrl).toEqual(
        "/items?x=1",
      );
    });
  });

  describe("CORS preflights", () => {
    const preflight = (
      service: HttpObserveAgentService<any>,
      headers: Record<string, string> = {
        origin: "https://app.example.com",
        "access-control-request-method": "GET",
      },
    ) => {
      let released = false;
      service.startHttpRequestTracing(
        {
          url: "/items/7?view=full",
          method: "OPTIONS",
          protocol: "http",
          headers,
        },
        {},
        () => {
          released = true;
        },
      );
      return released;
    };

    it("lets a preflight through untraced by default", () => {
      const service = createService();

      expect(preflight(service)).toBe(true);
      expect(startedTraces).toHaveLength(0);
    });

    it("traces a preflight when tracePreflights is on", () => {
      const service = createService({ tracePreflights: true });

      preflight(service);

      expect(startedTraces).toHaveLength(1);
    });

    it("traces an OPTIONS request that is not a preflight", () => {
      // The application's own OPTIONS handler: no Access-Control-Request-Method.
      const service = createService();

      preflight(service, { origin: "https://app.example.com" });

      expect(startedTraces).toHaveLength(1);
    });
  });

  describe("a trace id two open requests share", () => {
    it("keys every request by a key of its own, both reporting under the id", () => {
      // The generator stands in for an adopted `x-request-id`: a caller that
      // fans out sends the same one on every call.
      const service = createService();

      trace(service, "/items?page=1");
      trace(service, "/items?page=2");

      expect(startedTraces[0].traceId).not.toBe("trace-1");
      expect(startedTraces[1].traceId).not.toBe("trace-1");
      expect(startedTraces[0].traceId).not.toBe(startedTraces[1].traceId);
      expect(startedTraces.map((started) => started.reportedTraceId)).toEqual([
        "trace-1",
        "trace-1",
      ]);
    });
  });

  describe("execution ownership", () => {
    function createContext() {
      const als = new AsyncLocalStorage<Map<string, any>>();
      const registry = new OperationTraceRegistry(als as never, false);
      const getUserId = vi.fn(() => "test-user");
      const options = {
        serviceId: "http-isolation-test",
        traceIdKey: "traceId",
        traceIdGenerator: () => "shared-trace",
        attachTraceIdToLogs: false,
        skipInstrumentation: () => false,
        sourceContext: false,
        enabled: true,
        http: { getUserId },
      } as unknown as ObserveModuleOptionsWithDefaults;
      const snapshots: RequestSnapshot[] = [];
      const buffer = {
        insertRequestSnapshot: (snapshot: RequestSnapshot) =>
          snapshots.push(snapshot),
      } as unknown as ObserveAgentSharedBuffer;
      const agent = new HttpObserveAgentService(
        {} as HttpAdapterHost,
        als,
        options,
        registry,
        buffer,
        { shouldCapture: () => true } as unknown as TraceSamplerService,
      );
      const tracer = new TracerService(registry, als as never, buffer, options);
      const decorate = createInstanceDecorator(als, registry, {
        traceIdKey: options.traceIdKey,
        skipInstrumentation: () => false,
      });
      const handler = decorate({
        async run(callback: () => Promise<void>) {
          await callback();
        },
      }) as { run(callback: () => Promise<void>): Promise<void> };
      const run = (name: string, callback: () => Promise<void>) =>
        new Promise<void>((resolve, reject) => {
          agent.startHttpRequestTracing(
            { url: `/${name}`, method: "GET", protocol: "http" },
            {},
            () => {
              tracer.setOperationId(name);
              handler
                .run(callback)
                .finally(() => {
                  agent.endHttpRequestTracing({}, { statusCode: 200 });
                })
                .then(resolve, reject);
            },
          );
        });
      return {
        als,
        registry,
        snapshots,
        tracer,
        agent,
        options,
        getUserId,
        run,
      };
    }

    function startOtherTrace(registry: OperationTraceRegistry) {
      // Another operation registered under the public trace id itself.
      registry.startTrace("shared-trace", {
        protocol: "http",
        operationId: "/other",
      });
      const spanId = registry.internalStartTraceStep(
        "shared-trace",
        "OtherController",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep(
        "shared-trace",
        spanId,
        "OtherController",
        "handle",
        spanId,
      );
    }

    it("claims its key before an attribute callback can reach another request", async () => {
      const context = createContext();
      startOtherTrace(context.registry);
      let callbackKey: unknown;
      let registeredDuringCallback: boolean | undefined;
      context.options.http!.setAttributes = () => {
        callbackKey = context.als.getStore()!.get(TRACE_REGISTRY_KEY);
        registeredDuringCallback =
          typeof callbackKey === "string" &&
          context.registry.hasTrace(callbackKey);
        context.tracer.setOperationId("must-not-rename-other");
        return {};
      };

      await context.run("orders", async () => undefined);
      await waitFor(() => context.snapshots.length === 1, 2000, "snapshot");
      context.registry.endTrace("shared-trace", { statusCode: 200 });
      const otherSnapshot =
        await context.registry.pluckSnapshot("shared-trace");

      // Assertions stay outside setAttributes: its safety wrapper catches
      // thrown errors, which would also swallow a failing assertion.
      expect(callbackKey).toEqual(expect.any(String));
      expect(registeredDuringCallback).toBe(false);
      expect(otherSnapshot).toMatchObject({ operationId: "/other" });
      expect(context.snapshots[0]).toMatchObject({
        traceId: "shared-trace",
        operationId: "orders",
      });
    });

    it.each([
      ["missing", undefined],
      ["unregistered", "not-recorded"],
      ["invalid", 42],
    ] as const)(
      "does not complete a request with a %s registry key",
      async (_kind, key) => {
        const context = createContext();
        startOtherTrace(context.registry);
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
            context.agent.endHttpRequestTracing({}, { statusCode: 200 });
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

    it("does not let a completed request rename a later request with the same id", async () => {
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
        // A timer or callback created by the completed request keeps its old
        // store. Reusing the public id must not give it the new snapshot.
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

    it("ships both of two concurrent requests and releases their registry state", async () => {
      const context = createContext();
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const keys = new Set<string>();
      const requests = ["first", "second"].map((name) =>
        context.run(name, async () => {
          keys.add(context.als.getStore()!.get(TRACE_REGISTRY_KEY));
          (await context.tracer.activeSpan()).setTag("execution", name);
          await finish;
        }),
      );
      try {
        await waitFor(() => keys.size === 2, 2000, "both requests to start");
      } finally {
        release();
        await Promise.allSettled(requests);
      }
      await waitFor(() => context.snapshots.length === 2, 2000, "snapshots");
      for (const snapshot of context.snapshots) {
        expect(snapshot.traceId).toBe("shared-trace");
        expect(snapshot.traces).toHaveLength(1);
        expect(snapshot.traces[0].tags?.execution).toBe(snapshot.operationId);
      }
      expect([...keys].every((key) => !context.registry.hasTrace(key))).toBe(
        true,
      );
    });

    it("holds completion while a span of its own is still open", async () => {
      // Asked under any key but this request's own, the open-span check finds
      // no trace, answers that none is open, and the trace completes in a
      // microtask with its span still running.
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

  describe("a request that is not recorded", () => {
    const createTracedService = (
      ignore: NonNullable<ObserveModuleOptionsWithDefaults["http"]>["ignore"],
      shouldCapture: (url: string) => boolean,
    ) => {
      const als = new AsyncLocalStorage<Map<string, any>>();
      const options = {
        traceIdKey: "traceId",
        traceIdGenerator: () => "trace-1",
        http: { ignore },
      } as unknown as ObserveModuleOptionsWithDefaults;
      const registry = new OperationTraceRegistry(als as never, false);
      const service = new HttpObserveAgentService(
        {} as HttpAdapterHost,
        als,
        options,
        registry,
        {} as ObserveAgentSharedBuffer,
        {
          shouldCapture: (_: string, { url }: { url: string }) =>
            shouldCapture(url),
        } as unknown as TraceSamplerService,
      );
      const tracer = new TracerService(
        registry,
        als as never,
        {} as ObserveAgentSharedBuffer,
        options,
      );
      const handle = (url: string, operationId: string) => {
        let registryKey!: string;
        service.startHttpRequestTracing(
          { url, method: "GET", protocol: "http" },
          {},
          () => {
            registryKey = als.getStore()!.get(TRACE_REGISTRY_KEY);
            tracer.setOperationId(operationId);
          },
        );
        return registryKey;
      };
      return { registry, handle };
    };

    it.each([
      ["ignored", ["/health"], (url: string) => url !== "/health"],
      ["sampled out", [], (url: string) => url !== "/health"],
    ] as const)(
      "when %s, does not reach a recorded request sharing its trace id",
      async (_, ignore, shouldCapture) => {
        const { registry, handle } = createTracedService(
          [...ignore],
          shouldCapture,
        );

        const registryKey = handle("/orders", "orders.list");
        handle("/health", "health");
        // A trace with no spans is dropped when it ends.
        const spanId = registry.internalStartTraceStep(
          registryKey,
          "OrdersController",
          "findAll",
          undefined,
        );
        registry.internalEndTraceStep(
          registryKey,
          spanId,
          "OrdersController",
          "findAll",
          spanId,
        );
        registry.endTrace(registryKey, { statusCode: 200 });

        await expect(
          registry.pluckSnapshot(registryKey),
        ).resolves.toMatchObject({
          operationId: "orders.list",
        });
      },
    );
  });

  describe("stateful regex request ignores", () => {
    it.each([
      ["global direct regex", "g", false],
      ["sticky direct regex", "y", false],
      ["global method-scoped regex", "g", true],
      ["sticky method-scoped regex", "y", true],
    ] as const)(
      "always matches with a %s and preserves the configured lastIndex",
      (_name, flags, methodScoped) => {
        const pattern = new RegExp("^/health$", flags);
        pattern.lastIndex = 2;
        const ignore = methodScoped
          ? [{ method: "GET", path: pattern }]
          : [pattern];
        const service = createService({ ignore: ignore as never });
        const shouldIgnore = (
          service as unknown as {
            shouldIgnoreRequest: (req: {
              url: string;
              method: string;
            }) => boolean;
          }
        ).shouldIgnoreRequest.bind(service);

        const decisions = Array.from({ length: 6 }, () =>
          shouldIgnore({ url: "/health", method: "GET" }),
        );

        expect(decisions).toEqual([true, true, true, true, true, true]);
        expect(pattern.lastIndex).toBe(2);
      },
    );

    it("keeps an ordinary regex on the direct test path", () => {
      const pattern = /^\/health$/;
      const test = vi.spyOn(pattern, "test");
      const service = createService({ ignore: [pattern] });
      const shouldIgnore = (
        service as unknown as {
          shouldIgnoreRequest: (req: {
            url: string;
            method: string;
          }) => boolean;
        }
      ).shouldIgnoreRequest.bind(service);

      expect(shouldIgnore({ url: "/health", method: "GET" })).toBe(true);
      expect(test).toHaveBeenCalledTimes(1);
    });
  });
});
