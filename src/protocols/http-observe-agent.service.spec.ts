import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { HttpAdapterHost } from "@nestjs/core";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
import { TracerService } from "../services/tracer.service.js";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
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
    it("keys the first request by its trace id, and the second by a key of its own, both reporting under the id", () => {
      // The generator stands in for an adopted `x-request-id`: a caller that
      // fans out sends the same one on every call.
      const service = createService();

      trace(service, "/items?page=1");
      trace(service, "/items?page=2");

      expect(startedTraces[0].traceId).toBe("trace-1");
      expect(startedTraces[1].traceId).not.toBe("trace-1");
      expect(startedTraces.map((started) => started.reportedTraceId)).toEqual([
        "trace-1",
        "trace-1",
      ]);
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
      const handle = (url: string, operationId: string) =>
        service.startHttpRequestTracing(
          { url, method: "GET", protocol: "http" },
          {},
          () => tracer.setOperationId(operationId),
        );
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

        handle("/orders", "orders.list");
        handle("/health", "health");
        // A trace with no spans is dropped when it ends.
        const spanId = registry.internalStartTraceStep(
          "trace-1",
          "OrdersController",
          "findAll",
          undefined,
        );
        registry.internalEndTraceStep(
          "trace-1",
          spanId,
          "OrdersController",
          "findAll",
          spanId,
        );
        registry.endTrace("trace-1", { statusCode: 200 });

        await expect(registry.pluckSnapshot("trace-1")).resolves.toMatchObject({
          operationId: "orders.list",
        });
      },
    );
  });
});
