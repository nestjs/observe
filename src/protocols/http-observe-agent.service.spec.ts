import { AsyncLocalStorage } from "async_hooks";
import { HttpAdapterHost } from "@nestjs/core";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TraceSamplerService } from "../services/trace-sampler.service.js";
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
      {
        httpAdapter: { setOnRouteTriggered: () => {} },
      } as unknown as HttpAdapterHost,
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
});
