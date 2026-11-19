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

/** A hundred tags of 16 KiB each - the longest a tag is exported - one string. */
const LARGE_TAG = "x".repeat(16 * 1024);
const largeTags = () =>
  Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`large.${index}`, LARGE_TAG]),
  );

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

  // A receiver takes exports up to a size: a thousand large spans in one
  // would be refused whole.
  it("fills a batch by the text in it too, and sends the rest on at once", async () => {
    const exporter = exporterFor(receiver.url);
    for (let index = 0; index < 3; index++) {
      exporter.exportRequestSnapshot(snapshot(0, { tags: largeTags() }));
    }

    // About 1.6 M characters an operation: two do not fit in one batch of
    // 2 Mi, and the second goes out after the first without a flush.
    await waitFor(() => receiver.exports.length === 2, 3_000, "two exports");
    await exporter.onApplicationShutdown();

    expect(receiver.exports.map((received) => received.spans.length)).toEqual([
      2, 2, 2,
    ]);
    expect((exporter as unknown as { queuedChars: number }).queuedChars).toBe(
      0,
    );
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

  // `Retry-After` is whole seconds: a fraction of one is no reason to send
  // the same export again at once, on every flush.
  it("waits at least a second when the receiver asks to retry sooner", async () => {
    const exporter = exporterFor(receiver.url);
    receiver.answerNextWith(503, { "retry-after": "0.0000001" });
    exporter.exportRequestSnapshot(snapshot());
    exporter.flush();
    await waitFor(() => receiver.requests.length === 1, 3_000, "the export");
    const state = exporter as unknown as { sending: unknown };
    await waitFor(() => state.sending === null, 3_000, "the refusal");

    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      exporter.flush();
    }
    expect(receiver.requests).toHaveLength(1);

    await exporter.onApplicationShutdown();
    // The final export does not wait out the delay.
    expect(receiver.spans()).toHaveLength(2);
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

    /**
     * A receiver that answers 503 to every export `refuses`, and takes the
     * rest, noting the `url.path` of each request it took.
     */
    const startRefusing = async (refuses: (body: string) => boolean) => {
      const taken: string[] = [];
      const refused: string[] = [];
      await start((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const paths = pathsIn(body);
          if (refuses(body)) {
            refused.push(...paths);
            res.writeHead(503, { "content-type": "text/plain" });
            res.end("busy");
            return;
          }
          taken.push(...paths);
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      });
      const exporter = exporterFor(oddUrl, {
        otlp: { endpoint: oddUrl, protocol: "http/json", compression: "none" },
      });
      return { exporter, taken, refused };
    };

    const pathsIn = (body: string): string[] => {
      const parsed = JSON.parse(body) as {
        resourceSpans: Array<{
          scopeSpans: Array<{
            spans: Array<{
              attributes: Array<{
                key: string;
                value: { stringValue?: string };
              }>;
            }>;
          }>;
        }>;
      };
      return parsed.resourceSpans.flatMap(({ scopeSpans }) =>
        scopeSpans.flatMap(({ spans }) =>
          spans.flatMap(({ attributes }) =>
            attributes
              .filter(({ key }) => key === "url.path")
              .map(({ value }) => value.stringValue ?? ""),
          ),
        ),
      );
    };

    const request = (path: string) =>
      snapshot(0, {
        attributes: { method: "GET", statusCode: 200, originalUrl: path },
      });

    /** One export, waited out to its answer - and past the backoff it set. */
    const exportOnce = async (exporter: OtlpTraceExporter) => {
      const state = exporter as unknown as { sending: Promise<void> | null };
      exporter.flush();
      while (state.sending) {
        await state.sending;
      }
      vi.setSystemTime(Date.now() + 5 * 60_000);
    };

    const internals = (exporter: OtlpTraceExporter) =>
      exporter as unknown as {
        queue: unknown[];
        queuedChars: number;
        refusedSpans: number;
      };

    // A receiver may refuse a batch for what is in it - more than what it
    // passes spans on to takes - with the statuses it uses when it is away.
    // Retried first, and with whatever was queued since, such a batch kept
    // every later trace from being exported for as long as the process ran.
    it("lets later batches go ahead of one the receiver keeps turning away, and drops it once one of them got through", async () => {
      // Only the clock the backoff reads: the sockets keep theirs.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { exporter, taken, refused } = await startRefusing((body) =>
          body.includes("/poison"),
        );
        exporter.exportRequestSnapshot(request("/poison"));
        await exportOnce(exporter);
        expect(refused).toEqual(["/poison"]);

        exporter.exportRequestSnapshot(request("/later/1"));
        exporter.exportRequestSnapshot(request("/later/2"));
        await exportOnce(exporter);
        // The later batch went alone and got through; the refused one went
        // once more right after it, and was refused again.
        expect(taken).toEqual(["/later/1", "/later/2"]);
        expect(refused).toEqual(["/poison", "/poison"]);

        // Twice more, a backoff step apart, and it is gone: what waited
        // behind it goes next.
        exporter.exportRequestSnapshot(request("/later/3"));
        for (let attempt = 0; attempt < 3; attempt++) {
          await exportOnce(exporter);
        }
        expect(refused).toHaveLength(4);
        expect(taken).toEqual(["/later/1", "/later/2", "/later/3"]);

        exporter.exportRequestSnapshot(request("/later/4"));
        await exportOnce(exporter);
        await exporter.onApplicationShutdown();

        expect(taken).toEqual(["/later/1", "/later/2", "/later/3", "/later/4"]);
        expect(refused).toHaveLength(4);
        expect(
          log.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes("2 spans were dropped"),
          ),
        ).toBe(true);
        expect(internals(exporter)).toMatchObject({
          queue: [],
          queuedChars: 0,
          refusedSpans: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    // What the change above must not cost: a receiver that is away refuses
    // everything, and each batch goes again once it is back.
    it("loses nothing to a receiver that is away for a while", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let away = true;
        const { exporter, taken, refused } = await startRefusing(() => away);
        for (const index of [1, 2, 3]) {
          exporter.exportRequestSnapshot(request(`/during/${index}`));
          await exportOnce(exporter);
        }
        expect(refused).toEqual(["/during/1", "/during/2", "/during/3"]);
        // Set aside one by one, never dropped while nothing got through.
        expect(internals(exporter).refusedSpans).toBe(6);

        away = false;
        exporter.exportRequestSnapshot(request("/after"));
        await exportOnce(exporter);
        await exporter.onApplicationShutdown();

        expect(taken).toEqual([
          "/after",
          "/during/1",
          "/during/2",
          "/during/3",
        ]);
        expect(
          log.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes("dropped"),
          ),
        ).toBe(false);
        expect(internals(exporter)).toMatchObject({
          queue: [],
          queuedChars: 0,
          refusedSpans: 0,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    // Nor a receiver that limits how often it is sent to, and turns away
    // the export that comes right after the one it let through.
    it("loses nothing to a receiver that refuses an export right after one it took", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let tookLast = true;
        const { exporter, taken, refused } = await startRefusing(() => {
          const refuses = tookLast;
          tookLast = !refuses;
          return refuses;
        });
        exporter.exportRequestSnapshot(request("/first"));
        await exportOnce(exporter);
        exporter.exportRequestSnapshot(request("/second"));
        await exportOnce(exporter);
        await exportOnce(exporter);
        await exporter.onApplicationShutdown();

        expect(refused).toEqual(["/first", "/first"]);
        expect(taken).toEqual(["/second", "/first"]);
        expect(
          log.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes("dropped"),
          ),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("exports at shutdown what waits behind a batch the receiver refuses", async () => {
      const { exporter, taken, refused } = await startRefusing((body) =>
        body.includes("/poison"),
      );
      exporter.exportRequestSnapshot(request("/poison"));
      exporter.flush();
      await waitFor(() => refused.length === 1, 3_000, "the refusal");
      exporter.exportRequestSnapshot(request("/later"));

      // No backoff is waited out at shutdown, and a refusal ends nothing.
      await exporter.onApplicationShutdown();

      expect(taken).toEqual(["/later"]);
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
      // One full batch, too much for the kernel to take unread. Three bytes
      // a character, so that it stays one batch, within its characters.
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
                methodKey: "€".repeat(950),
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

  // Node emits no response for a 101 with `Connection: Upgrade`: an export
  // waiting on one would never settle, and every export after it would wait
  // behind it for the life of the process.
  it("drops an export answered with an upgrade nobody asked for, and sends the next", async () => {
    let connections = 0;
    const upgrading = createServer((connection) => {
      connections += 1;
      const first = connections === 1;
      connection.on("error", () => undefined);
      connection.once("data", () =>
        connection.write(
          first
            ? "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
            : "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
        ),
      );
    });
    const port = await freePort();
    await new Promise<void>((resolve) =>
      upgrading.listen(port, "127.0.0.1", resolve),
    );
    const exporter = exporterFor(`http://127.0.0.1:${port}`);
    try {
      exporter.exportRequestSnapshot(snapshot());
      exporter.flush();
      await waitFor(
        () =>
          warn.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes("101"),
          ),
        3_000,
        "the refusal",
      );

      exporter.exportRequestSnapshot(snapshot());
      exporter.flush();
      await waitFor(() => connections === 2, 3_000, "the next export");
    } finally {
      await exporter.onApplicationShutdown();
      await new Promise((resolve) => upgrading.close(resolve));
    }
  });

  describe("against a receiver that keeps sending interim replies", () => {
    let chatty: Server;
    let sockets: Socket[];
    let chattyUrl: string;
    let timers: NodeJS.Timeout[];

    /** Answers every export with `102 Processing`, every `everyMs`, forever. */
    const start = async (everyMs: number) => {
      sockets = [];
      timers = [];
      chatty = createServer((socket) => {
        sockets.push(socket);
        socket.on("error", () => undefined);
        socket.once("data", () => {
          timers.push(
            setInterval(() => {
              if (!socket.destroyed) {
                socket.write("HTTP/1.1 102 Processing\r\n\r\n");
              }
            }, everyMs),
          );
        });
      });
      const port = await freePort();
      await new Promise<void>((resolve) =>
        chatty.listen(port, "127.0.0.1", resolve),
      );
      chattyUrl = `http://127.0.0.1:${port}`;
    };

    afterEach(async () => {
      timers.forEach(clearInterval);
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => chatty.close(resolve));
    });

    const failure = () =>
      warn.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .find((line: string) => line.includes("could not be reached"));

    // `timeoutMillis` is how long one export may take, not how long the
    // socket may stay silent: each interim reply would start that over.
    it("gives up on an export at its timeout, however the receiver keeps writing", async () => {
      await start(150);
      const exporter = exporterFor(chattyUrl, {
        otlp: {
          endpoint: chattyUrl,
          protocol: "http/json",
          timeoutMillis: 600,
        },
      });
      try {
        exporter.exportRequestSnapshot(snapshot());
        exporter.flush();

        await waitFor(() => failure() !== undefined, 3_000, "the timeout");
        expect(failure()).toContain("ETIMEDOUT");
      } finally {
        await exporter.onApplicationShutdown();
      }
    });

    // Nothing the exporter sends asks for one, and each is parsed on the
    // application's thread.
    it("gives up on an export after eight interim replies", async () => {
      await start(5);
      const exporter = exporterFor(chattyUrl, {
        otlp: {
          endpoint: chattyUrl,
          protocol: "http/json",
          timeoutMillis: 60_000,
        },
      });
      try {
        exporter.exportRequestSnapshot(snapshot());
        exporter.flush();

        await waitFor(() => failure() !== undefined, 3_000, "the refusal");
        expect(failure()).toContain("interim");
      } finally {
        await exporter.onApplicationShutdown();
      }
    });
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

    it("bounds what waits by the text in it too, however few the spans", async () => {
      const exporter = exporterFor(silentUrl);

      // About 1.6 M characters an operation, in 16 KiB tags: 40 of them
      // are 80 spans, far from the limit on spans.
      for (let index = 0; index < 40; index++) {
        exporter.exportRequestSnapshot(snapshot(0, { tags: largeTags() }));
      }

      const state = exporter as unknown as {
        queue: unknown[];
        queuedChars: number;
      };
      // The first export took one operation and never returns; twenty more
      // fit in 32 Mi characters behind it, and the rest not at all.
      expect(state.queue).toHaveLength(2 * 20);
      expect(state.queuedChars).toBeLessThanOrEqual(32 * 1024 * 1024);
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
