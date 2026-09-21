import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, IncomingHttpHeaders, Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { createObserveModule } from "../observe.module.js";
import { freePort, waitFor } from "../testing/observe-harness.js";

interface ReceivedBatch {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  payload: { snapshots?: Array<Record<string, any>> };
}

let downstreamUrl = "";

@Controller()
class ShopController {
  @Get("boom")
  boom() {
    throw new Error("deliberate");
  }

  @Get("rates")
  async rates() {
    const response = await fetch(`${downstreamUrl}/rates`);
    return response.json();
  }

  @Get("long")
  async long() {
    // Open across at least two flushes, so the agent sends while this
    // request's async context - trace id and all - is live in the process.
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const response = await fetch(`${downstreamUrl}/late`);
    return response.json();
  }
}

const spanNames = (nodes: Array<Record<string, any>> = []): string[] =>
  nodes.flatMap((node) => [`${node.c}#${node.m}`, ...spanNames(node.ch)]);

/**
 * Nothing in the harness is intercepted here: snapshots go into the shared
 * buffer, the worker thread drains it and posts to a collector this suite
 * runs, and the assertions are made on what that collector received.
 *
 * Two promises only this shows. The capture has to survive the whole trip -
 * the encoder, the shared buffer, the worker's JSON and gzip - and arrive as
 * `rq`. And the agent's own requests must stay out of the telemetry they
 * carry: an agent that traced its own flush would produce a span per batch,
 * each making the next batch non-empty, for ever.
 */
describe("ObserveModule: the transport to the collector", () => {
  let app: INestApplication;
  let baseUrl: string;
  let collector: Server;
  let collectorPort: number;
  let downstream: Server;
  const batches: ReceivedBatch[] = [];
  const downstreamHeaders: IncomingHttpHeaders[] = [];

  const snapshotsReceived = () =>
    batches.flatMap((batch) => batch.payload.snapshots ?? []);
  const received = (operation: string) =>
    snapshotsReceived().find((snapshot) => snapshot.op === operation);

  beforeAll(async () => {
    collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        batches.push({
          url: req.url,
          headers: req.headers,
          payload: JSON.parse(gunzipSync(Buffer.concat(chunks)).toString()),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    collectorPort = await freePort();
    await new Promise<void>((resolve) =>
      collector.listen(collectorPort, resolve),
    );

    downstream = createServer((req, res) => {
      downstreamHeaders.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    const downstreamPort = await freePort();
    await new Promise<void>((resolve) =>
      downstream.listen(downstreamPort, resolve),
    );
    downstreamUrl = `http://127.0.0.1:${downstreamPort}`;

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "test-key",
          appSecret: "test-secret",
          serviceId: "transport-app",
          endpoint: `http://127.0.0.1:${collectorPort}`,
          // The agent's floor; anything lower is clamped to this.
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: false,
          http: { capture: { body: true } },
        }),
      ],
      controllers: [ShopController],
    })
    class TransportModule {}

    app = await NestFactory.create(TransportModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => collector.close(resolve));
    await new Promise((resolve) => downstream.close(resolve));
  });

  it("delivers a failed request's capture to the collector as `rq`", async () => {
    const response = await fetch(`${baseUrl}/boom`, {
      headers: {
        "user-agent": "transport-int",
        authorization: "Bearer should-never-leave",
      },
    });
    expect(response.status).toBe(500);

    await waitFor(() => Boolean(received("/boom")), 8_000, "/boom to arrive");
    const snapshot = received("/boom")!;

    expect(snapshot.rq.headers["user-agent"]).toBe("transport-int");
    expect(snapshot.e).toBeDefined();
    expect(snapshot).not.toHaveProperty("request");
    expect(JSON.stringify(batches)).not.toContain("should-never-leave");
  });

  it("sends its batches without a trace header, and records none of them as spans", async () => {
    const [long, rates] = await Promise.all([
      fetch(`${baseUrl}/long`, { headers: { "x-request-id": "long-trace-1" } }),
      fetch(`${baseUrl}/rates`),
    ]);
    expect(long.status).toBe(200);
    expect(rates.status).toBe(200);

    await waitFor(() => Boolean(received("/long")), 8_000, "/long to arrive");
    // One more flush after it, so a span born of the send that carried
    // `/long` would have had its chance to show up.
    const seen = batches.length;
    await fetch(`${baseUrl}/rates`);
    await waitFor(() => batches.length > seen, 8_000, "one more batch");

    // The application's own outbound calls are there, under their requests,
    // and carry the trace id...
    const longSpans = spanNames(received("/long")!.t);
    expect(longSpans).toContain(
      `http#GET ${downstreamUrl.replace("http://", "")}`,
    );
    expect(
      downstreamHeaders.some(
        (headers) => headers["x-request-id"] === "long-trace-1",
      ),
    ).toBe(true);

    // ...and the agent's are not: no span names the collector, no snapshot
    // is of a request to it, and no batch arrived under anybody's trace id -
    // not even the ones sent while `/long` was open.
    expect(batches.length).toBeGreaterThanOrEqual(2);
    const everySpan = snapshotsReceived().flatMap((snapshot) =>
      spanNames(snapshot.t),
    );
    expect(
      everySpan.filter((name) => name.includes(String(collectorPort))),
    ).toEqual([]);
    expect(JSON.stringify(batches.map((batch) => batch.payload))).not.toContain(
      `127.0.0.1:${collectorPort}`,
    );
    for (const batch of batches) {
      expect(batch.headers).not.toHaveProperty("x-request-id");
    }
  });
});
