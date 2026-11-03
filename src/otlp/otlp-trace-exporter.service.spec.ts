import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { createServer, Server, Socket } from "net";
import type { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import {
  FakeOtlpReceiver,
  startFakeOtlpReceiver,
} from "../testing/fake-otlp-receiver.js";
import { freePort, waitFor } from "../testing/observe-harness.js";
import { OtlpTraceExporter } from "./otlp-trace-exporter.service.js";

const options = (
  overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
): ObserveModuleOptionsWithDefaults =>
  ({
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    serviceId: "orders-api",
    traceIdKey: "traceId",
    flushInterval: 60_000,
    shutdownFlushTimeout: 1_000,
    openTelemetry: true,
    ...overrides,
  }) as ObserveModuleOptionsWithDefaults;

/** A finished request carrying `children` spans under its handler. */
const snapshot = (
  children = 0,
  overrides: Partial<RequestSnapshot> = {},
): RequestSnapshot =>
  ({
    traceId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    calledAt: new Date().toISOString(),
    duration: 5,
    protocol: "http",
    operationId: "/orders",
    attributes: { method: "GET", statusCode: 200, originalUrl: "/orders" },
    traces: [
      {
        origin: "auto",
        className: "OrdersController",
        methodKey: "list",
        duration: 4,
        startOffset: 0,
        children: Array.from({ length: children }, () => ({
          origin: "auto",
          className: "OrdersService",
          methodKey: "load",
          duration: 1,
          startOffset: 1,
        })),
      },
    ],
    ...overrides,
  }) as RequestSnapshot;

function exporterFor(endpoint: string, overrides = {}) {
  const exporter = new OtlpTraceExporter(
    options({ otlp: { endpoint, protocol: "http/json" }, ...overrides }),
    new OperationTraceRegistry(new AsyncLocalStorage()),
    new AsyncLocalStorage(),
  );
  exporter.onModuleInit();
  return exporter;
}

describe("OtlpTraceExporter", () => {
  let receiver: FakeOtlpReceiver;
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    receiver = await startFakeOtlpReceiver();
    warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await receiver.close();
  });

  it("is a no-op unless otlp asks for export", async () => {
    const exporter = new OtlpTraceExporter(
      options(),
      new OperationTraceRegistry(new AsyncLocalStorage()),
      new AsyncLocalStorage(),
    );
    exporter.onModuleInit();
    exporter.exportRequestSnapshot(snapshot());
    exporter.flush();
    await exporter.onApplicationShutdown();

    expect(exporter.enabled).toBe(false);
    expect(receiver.requests).toEqual([]);
  });

  it("exports only beside reporting to Observe, never instead of it", async () => {
    const hosted = "https://observe-api.nestjs.com";
    const exporterWith = (
      overrides: Partial<ObserveModuleOptionsWithDefaults>,
    ) =>
      new OtlpTraceExporter(
        options({
          otlp: { endpoint: receiver.url, protocol: "http/json" },
          ...overrides,
        }),
        new OperationTraceRegistry(new AsyncLocalStorage()),
        new AsyncLocalStorage(),
      );

    // The agent sends Observe nothing, so nothing is exported either.
    for (const overrides of [
      { enabled: false },
      { appKey: undefined, appSecret: undefined, endpoint: hosted },
      { appSecret: undefined, endpoint: hosted },
      { appKey: "YOUR_APP_KEY", appSecret: "YOUR_APP_SECRET" },
    ]) {
      const exporter = exporterWith(overrides);
      exporter.onModuleInit();
      exporter.exportRequestSnapshot(snapshot());
      await exporter.onApplicationShutdown();

      expect(exporter.enabled).toBe(false);
    }
    expect(receiver.requests).toEqual([]);
    expect(log).not.toHaveBeenCalled();

    // A proxy in front of Observe adds the credentials on its way there.
    const behindProxy = exporterWith({
      appKey: undefined,
      appSecret: undefined,
      endpoint: "http://observe-proxy.internal:8080",
    });
    expect(behindProxy.enabled).toBe(true);
    await behindProxy.onApplicationShutdown();
  });

  it("stays off without openTelemetry, and says why once at start-up", async () => {
    const exporter = new OtlpTraceExporter(
      options({
        openTelemetry: false,
        otlp: { endpoint: receiver.url, protocol: "http/json" },
      }),
      new OperationTraceRegistry(new AsyncLocalStorage()),
      new AsyncLocalStorage(),
    );
    exporter.onModuleInit();
    exporter.exportRequestSnapshot(snapshot());
    await exporter.onApplicationShutdown();

    expect(exporter.enabled).toBe(false);
    expect(receiver.requests).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "OTLP export is off: `otlp` takes `openTelemetry: true`",
    );
  });

  it("says once at start-up why it cannot run beside an agent that reports nothing", async () => {
    const exporter = new OtlpTraceExporter(
      options({
        appKey: "YOUR_APP_KEY",
        appSecret: "YOUR_APP_SECRET",
        otlp: { endpoint: receiver.url },
      }),
      new OperationTraceRegistry(new AsyncLocalStorage()),
      new AsyncLocalStorage(),
    );
    exporter.onModuleInit();
    await exporter.onApplicationShutdown();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(
      "OTLP export is off: it runs beside reporting to NestJS Observe",
    );
  });

  it("says nothing at all when otlp is not set, or the agent is switched off", async () => {
    for (const overrides of [
      {},
      { enabled: false, otlp: { endpoint: receiver.url } },
    ]) {
      const exporter = new OtlpTraceExporter(
        options(overrides),
        new OperationTraceRegistry(new AsyncLocalStorage()),
        new AsyncLocalStorage(),
      );
      exporter.onModuleInit();
      await exporter.onApplicationShutdown();
    }

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("says at start-up that export waits for the collector's word on the plan", async () => {
    const exporter = exporterFor(receiver.url);
    await exporter.onApplicationShutdown();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain(
      `OTLP export to ${receiver.url}/v1/traces (http/json) starts once NestJS Observe accepts`,
    );
  });

  it("exports an operation without its tree when told to, as its own span alone", async () => {
    const exporter = exporterFor(receiver.url);
    exporter.exportRequestSnapshot(snapshot(3), false);
    exporter.exportJobSnapshot(
      {
        id: "1",
        traceId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        name: "send",
        queueName: "emails",
        calledAt: new Date().toISOString(),
        duration: 3,
        traces: [
          {
            origin: "auto",
            className: "EmailsProcessor",
            methodKey: "process",
            duration: 2,
            startOffset: 0,
          },
        ],
      } as never,
      false,
    );
    await exporter.onApplicationShutdown();

    expect(receiver.spans().map((span) => span.name)).toEqual([
      "GET /orders",
      "emails send",
    ]);
  });

  it("leaves out a request whose caller sampled its trace out, as a parent-based sampler would", async () => {
    const registry = new OperationTraceRegistry(new AsyncLocalStorage());
    const sampledOut = snapshot(1);
    const sampledIn = snapshot(1, { operationId: "/sampled" });
    vi.spyOn(registry, "traceContextOf").mockImplementation((of) =>
      of === sampledOut
        ? {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            parentSpanId: "00f067aa0ba902b7",
            sampled: false,
          }
        : {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4737",
            parentSpanId: "00f067aa0ba902b8",
            sampled: true,
          },
    );
    const exporter = new OtlpTraceExporter(
      options({ otlp: { endpoint: receiver.url, protocol: "http/json" } }),
      registry,
      new AsyncLocalStorage(),
    );
    exporter.onModuleInit();

    exporter.exportRequestSnapshot(sampledOut);
    exporter.exportRequestSnapshot(sampledIn);
    await exporter.onApplicationShutdown();

    expect(receiver.spans().map((span) => span.traceId)).toEqual([
      "4bf92f3577b34da6a3ce929d0e0e4737",
      "4bf92f3577b34da6a3ce929d0e0e4737",
      "4bf92f3577b34da6a3ce929d0e0e4737",
    ]);
    expect(receiver.spans()[0].parentSpanId).toBe("00f067aa0ba902b8");
  });

  it("sends a full batch at once, without waiting for the interval", async () => {
    const exporter = exporterFor(receiver.url);
    exporter.exportRequestSnapshot(snapshot(1_200));

    await waitFor(
      () => receiver.spans().length >= 1_000,
      3_000,
      "the first full batch",
    );
    await exporter.onApplicationShutdown();

    expect(receiver.exports[0].spans).toHaveLength(1_000);
    // The rest go in the final export.
    expect(receiver.spans()).toHaveLength(1_202);
  });

  it("drops an answer that will not change - a 400 - says so once, and says when it works again", async () => {
    const exporter = exporterFor(receiver.url);
    receiver.answerNextWith(400);
    receiver.answerNextWith(400);

    for (let attempt = 0; attempt < 2; attempt++) {
      exporter.exportRequestSnapshot(snapshot());
      exporter.flush();
      await waitFor(
        () => receiver.requests.length === attempt + 1,
        3_000,
        "the export",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("answered 400");
    expect(String(warn.mock.calls[0][0])).toContain("dropped");

    exporter.exportRequestSnapshot(snapshot());
    exporter.flush();
    await waitFor(() => receiver.spans().length === 2, 3_000, "the export");
    await waitFor(
      () =>
        log.mock.calls.some((call: unknown[]) =>
          String(call[0]).includes("working again"),
        ),
      3_000,
      "the recovery line",
    );
    // Only the third batch arrived: the refused two were not resent.
    expect(receiver.exports).toHaveLength(1);
    await exporter.onApplicationShutdown();
  });

  describe("against a receiver that never answers", () => {
    let silent: Server;
    let sockets: Socket[];
    let silentUrl: string;

    beforeEach(async () => {
      sockets = [];
      silent = createServer((socket) => sockets.push(socket));
      const port = await freePort();
      await new Promise<void>((resolve) =>
        silent.listen(port, "127.0.0.1", resolve),
      );
      silentUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((resolve) => silent.close(resolve));
    });

    it("bounds what waits, drops whole operations past it, and says so once", async () => {
      const exporter = exporterFor(silentUrl);

      // 1,001 spans each: the first starts an export that never returns,
      // and the queue fills behind it.
      for (let index = 0; index < 12; index++) {
        exporter.exportRequestSnapshot(snapshot(999));
      }

      const queued = (exporter as unknown as { queue: unknown[] }).queue;
      // The first export took 1,000 and left one span behind; nine more
      // operations fit whole behind it, and the last two not at all.
      expect(queued.length).toBe(1 + 9 * 1_001);
      const drops = warn.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes("falling behind"),
      );
      expect(drops).toHaveLength(1);

      await exporter.onApplicationShutdown();
    });

    it("gives up on the final export at the shutdown deadline", async () => {
      const exporter = exporterFor(silentUrl, { shutdownFlushTimeout: 200 });
      exporter.exportRequestSnapshot(snapshot());

      const started = Date.now();
      await exporter.onApplicationShutdown();

      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });
});
