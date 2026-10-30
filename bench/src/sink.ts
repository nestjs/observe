import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { validateTelemetryPayload } from "../../dist/agent/telemetry-wire-contract.js";
import type { SinkMessage, SinkStats } from "./protocol.js";

/**
 * Stands in for the collector, in a process of its own so that receiving
 * batches costs the application under test nothing. Every batch is checked
 * against the SDK's own copy of the collector's validation, so a run that
 * measured a pipeline the real collector would refuse says so.
 */

interface WireSpan {
  ch?: WireSpan[];
  t?: Record<string, unknown>;
}

const COLLAPSED_TAG = "observe.collapsed";

let stats: SinkStats = emptyStats();

function emptyStats(): SinkStats {
  return {
    batches: 0,
    bytes: 0,
    snapshots: 0,
    wireSpans: 0,
    calls: 0,
    violations: [],
  };
}

function countSpans(spans: WireSpan[] | undefined): void {
  for (const span of spans ?? []) {
    stats.wireSpans += 1;
    const collapsed = span.t?.[COLLAPSED_TAG];
    stats.calls += typeof collapsed === "number" ? collapsed : 1;
    countSpans(span.ch);
  }
}

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
    const body = Buffer.concat(chunks);
    stats.batches += 1;
    stats.bytes += body.length;
    try {
      const batch = JSON.parse(gunzipSync(body).toString()) as {
        snapshots?: Array<{ t?: WireSpan[] }>;
      };
      for (const snapshot of batch.snapshots ?? []) {
        stats.snapshots += 1;
        countSpans(snapshot.t);
      }
      const violations = validateTelemetryPayload(batch, {
        forbidUnknown: true,
      });
      if (violations.length > 0 && stats.violations.length < 20) {
        stats.violations.push(...violations.slice(0, 5));
      }
    } catch (error) {
      stats.violations.push(`unreadable batch on ${req.url}: ${String(error)}`);
    }
  });
});

process.on("message", (message: { type: string }) => {
  if (message.type === "stats") {
    send({ type: "stats", stats });
    stats = emptyStats();
  }
});

server.listen(Number(process.env.BENCH_SINK_PORT ?? 0), "127.0.0.1", () => {
  send({
    type: "ready",
    port: (server.address() as { port: number }).port,
  });
});

function send(message: SinkMessage) {
  process.send?.(message);
}
