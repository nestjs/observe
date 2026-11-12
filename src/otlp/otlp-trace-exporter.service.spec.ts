import { Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import {
  createServer as createHttpServer,
  Server as HttpServer,
} from "node:http";
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

  it("puts a job under the span that handed it on, and leaves out one handed on in a trace sampled out", async () => {
    const registry = new OperationTraceRegistry(new AsyncLocalStorage());
    const job = (id: string) =>
      ({
        id,
        traceId: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
        name: "send",
        queueName: "emails",
        calledAt: new Date().toISOString(),
        duration: 3,
        traces: [],
      }) as never;
    const sampledOut = job("1");
    const handedOn = job("2");
    vi.spyOn(registry, "traceContextOf").mockImplementation((of) =>
      of === sampledOut
        ? {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            parentSpanId: "00f067aa0ba902b7",
            sampled: false,
          }
        : {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
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

    exporter.exportJobSnapshot(sampledOut);
    exporter.exportJobSnapshot(handedOn);
    await exporter.onApplicationShutdown();

    expect(receiver.spans()).toHaveLength(1);
    expect(receiver.spans()[0].parentSpanId).toBe("00f067aa0ba902b8");
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

  describe("against a receiver that answers out of the ordinary", () => {
    let odd: HttpServer;
    let oddUrl: string;

    const start = async (handler: Parameters<typeof createHttpServer>[1]) => {
      odd = createHttpServer(handler);
      await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
      oddUrl = `http://127.0.0.1:${(odd.address() as { port: number }).port}`;
    };

    afterEach(async () => {
      odd.closeAllConnections();
      await new Promise((resolve) => odd.close(resolve));
    });

    // Read on the application's thread: past 64 KiB a reply is no longer
    // the receiver's to size.
    it("stops reading a reply past 64 KiB, and still acts on its status", async () => {
      let written = 0;
      await start((req, res) => {
        req.resume();
        res.writeHead(400, { "content-type": "text/plain" });
        const chunk = Buffer.alloc(16 * 1024, "x");
        const more = () => {
          while (!res.destroyed && written < 8 * 1024 * 1024) {
            written += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", more);
              return;
            }
          }
        };
        more();
      });
      const exporter = exporterFor(oddUrl);
      exporter.exportRequestSnapshot(snapshot());
      exporter.flush();

      await waitFor(
        () =>
          warn.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes("answered 400"),
          ),
        3_000,
        "the refusal",
      );
      expect(written).toBeLessThan(8 * 1024 * 1024);
      await exporter.onApplicationShutdown();
    }, 10_000);
  });

  // A receiver that answers off the head of an export and stops reading: the
  // export is over, but its upload never finishes, and a socket nobody pools
  // or times out any more would stay open, one more per export.
  it("lets go of the connection when the reply ends before the export is written", async () => {
    let closed = false;
    let socket: Socket | undefined;
    const early = createServer((connection) => {
      socket = connection;
      connection.once("data", () => {
        connection.pause();
        connection.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
            "Connection: keep-alive\r\nContent-Length: 2\r\n\r\n{}",
        );
      });
      connection.on("error", () => undefined);
      connection.on("close", () => (closed = true));
      connection.on("end", () => (closed = true));
    });
    const port = await freePort();
    await new Promise<void>((resolve) =>
      early.listen(port, "127.0.0.1", resolve),
    );
    const exporter = exporterFor(`http://127.0.0.1:${port}`, {
      otlp: {
        endpoint: `http://127.0.0.1:${port}`,
        protocol: "http/json",
        compression: "none",
      },
    });
    try {
      // One full batch, too much for the kernel to take unread.
      const [handler] = snapshot().traces as unknown as Array<
        Record<string, unknown>
      >;
      exporter.exportRequestSnapshot(
        snapshot(0, {
          traces: [
            {
              ...handler,
              children: Array.from({ length: 999 }, () => ({
                origin: "auto",
                className: "OrdersService",
                methodKey: "m".repeat(4_000),
                duration: 1,
                startOffset: 1,
              })),
            },
          ] as RequestSnapshot["traces"],
        }),
      );
      const state = exporter as unknown as { sending: Promise<void> | null };
      await waitFor(() => socket !== undefined, 3_000, "the export");
      await waitFor(() => state.sending === null, 3_000, "its reply");

      // Read now: a released request comes to its end, a held one waits.
      await new Promise((resolve) => setTimeout(resolve, 200));
      socket!.resume();
      await waitFor(() => closed, 3_000, "the connection to close").catch(
        () => undefined,
      );
      expect(closed).toBe(true);
    } finally {
      socket?.destroy();
      await exporter.onApplicationShutdown();
      await new Promise((resolve) => early.close(resolve));
    }
  }, 15_000);

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
