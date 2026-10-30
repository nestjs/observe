import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { createServer, Server, Socket } from "net";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
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

describe("ObserveAgentSharedBuffer: the hand-off to OTLP export", () => {
  const exporter = () => ({
    exportRequestSnapshot: vi.fn(),
    exportJobSnapshot: vi.fn(),
  });
  const bufferWith = (
    otlp: ReturnType<typeof exporter>,
    overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
  ) =>
    new ObserveAgentSharedBuffer(
      options(overrides),
      undefined,
      otlp as unknown as OtlpTraceExporter,
    );

  it("hands over every request, whole, whatever the Observe collector said about the account", () => {
    const otlp = exporter();
    const buffer = bufferWith(otlp);
    buffer.setIngestMode("errors-only");
    const request = snapshot(3);

    buffer.insertRequestSnapshot(request);

    expect(otlp.exportRequestSnapshot).toHaveBeenCalledWith(request);
    expect(
      (request.traces[0] as { children?: unknown[] }).children,
    ).toHaveLength(3);
  });

  it("hands over what Observe's own batch leaves out: past maxTracesPerBatch, or with no operation id", () => {
    const otlp = exporter();
    const buffer = bufferWith(otlp, { maxTracesPerBatch: 1 });

    buffer.insertRequestSnapshot(snapshot());
    buffer.insertRequestSnapshot(snapshot());
    buffer.insertRequestSnapshot(
      snapshot(0, { operationId: undefined, attributes: undefined }),
    );
    buffer.insertJobSnapshot({
      id: "1",
      traceId: "t",
      name: "job",
      queueName: "emails",
      traces: [],
    });
    buffer.insertJobSnapshot({
      id: "2",
      traceId: "t",
      name: "job",
      queueName: "emails",
      traces: [],
    });

    expect(otlp.exportRequestSnapshot).toHaveBeenCalledTimes(3);
    expect(otlp.exportJobSnapshot).toHaveBeenCalledTimes(2);
  });
});
