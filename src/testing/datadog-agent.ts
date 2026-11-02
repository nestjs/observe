import { createServer, Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExportedSpan } from "./otlp-receiver.js";

/**
 * Whether dd-trace runs here at all: dd-trace 6 supports Node 22 and later,
 * and the agent's floor is 20.19, so the Datadog suites skip themselves on
 * the runtimes it does not start on.
 */
export const datadogRuns = Number(process.versions.node.split(".")[0]) >= 22;

/**
 * The environment every dd-trace in a suite runs with, beside where its
 * Agent is: spans flushed moments after they end rather than every two
 * seconds, and nothing else phoning home - no Agent here answers telemetry,
 * remote configuration or crash reports.
 */
export const DATADOG_TEST_ENV = {
  DD_TRACE_FLUSH_INTERVAL: "50",
  DD_TRACE_STARTUP_LOGS: "false",
  DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
  DD_REMOTE_CONFIGURATION_ENABLED: "false",
  DD_CRASHTRACKING_ENABLED: "false",
} as const;

export interface DatadogAgent {
  /** What to hand dd-trace as `DD_TRACE_AGENT_URL`. */
  readonly url: string;
  /**
   * Every span received, in order of arrival - ids written as W3C writes
   * them, the trace id with its upper 64 bits from `_dd.p.tid`, and the
   * request path as `url.path`, so the OpenTelemetry suites' span helpers
   * read them as they read an OTLP receiver's.
   */
  readonly spans: ExportedSpan[];
  close(): Promise<void>;
}

/** A span as dd-trace encodes it for the Agent's `/v0.4/traces`. */
interface AgentSpan {
  trace_id: bigint | number;
  span_id: bigint | number;
  parent_id: bigint | number;
  name: string;
  service: string;
  meta?: Record<string, string>;
}

const KINDS = new Set<string>([
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
]);

const hex64 = (id: bigint | number): string =>
  BigInt(id).toString(16).padStart(16, "0");

const pathOf = (url: string | undefined): string | undefined => {
  try {
    return url === undefined ? undefined : new URL(url).pathname;
  } catch {
    return undefined;
  }
};

/**
 * A Datadog Agent on a free local port, as far as a tracer can tell: it takes
 * the traces dd-trace sends - MessagePack, protocol 0.4, its default - and
 * keeps every span, so a suite can ask which trace each service put its part
 * of a request in. Anything else a tracer asks for gets an empty answer.
 */
export async function startDatadogAgent(): Promise<DatadogAgent> {
  const spans: ExportedSpan[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url?.startsWith("/v0.4/traces")) {
        try {
          const [traces] = decode(Buffer.concat(chunks), 0);
          for (const trace of traces as AgentSpan[][]) {
            // Only the first span of a chunk carries the propagated tags.
            const upper =
              trace.map((span) => span.meta?.["_dd.p.tid"]).find(Boolean) ??
              "0".repeat(16);
            for (const span of trace) {
              const meta = span.meta ?? {};
              const kind = meta["span.kind"] ?? "internal";
              spans.push({
                service: span.service,
                traceId: `${upper}${hex64(span.trace_id)}`,
                spanId: hex64(span.span_id),
                parentSpanId:
                  BigInt(span.parent_id) === 0n
                    ? undefined
                    : hex64(span.parent_id),
                kind: (KINDS.has(kind)
                  ? kind
                  : "internal") as ExportedSpan["kind"],
                name: span.name,
                attributes: { ...meta, "url.path": pathOf(meta["http.url"]) },
              });
            }
          }
        } catch {
          res.writeHead(400).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ rate_by_service: {} }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  // Not `listenOnLoopback`: this module loads before dd-trace starts in a
  // suite's process, and the harness would load Nest along with it.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    spans,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Reads the MessagePack value at `offset`, and where the next one starts.
 * Every format but extensions, which dd-trace does not send: 64-bit integers
 * come back as `bigint`, so span ids keep every bit.
 */
function decode(buffer: Buffer, offset: number): [unknown, number] {
  const type = buffer[offset];
  if (type <= 0x7f) {
    return [type, offset + 1];
  }
  if (type >= 0xe0) {
    return [type - 0x100, offset + 1];
  }
  if (type >= 0x80 && type <= 0x8f) {
    return decodeMap(buffer, offset + 1, type & 0x0f);
  }
  if (type >= 0x90 && type <= 0x9f) {
    return decodeArray(buffer, offset + 1, type & 0x0f);
  }
  if (type >= 0xa0 && type <= 0xbf) {
    return decodeString(buffer, offset + 1, type & 0x1f);
  }
  switch (type) {
    case 0xc0:
      return [null, offset + 1];
    case 0xc2:
      return [false, offset + 1];
    case 0xc3:
      return [true, offset + 1];
    case 0xc4:
      return decodeBytes(buffer, offset + 2, buffer.readUInt8(offset + 1));
    case 0xc5:
      return decodeBytes(buffer, offset + 3, buffer.readUInt16BE(offset + 1));
    case 0xc6:
      return decodeBytes(buffer, offset + 5, buffer.readUInt32BE(offset + 1));
    case 0xca:
      return [buffer.readFloatBE(offset + 1), offset + 5];
    case 0xcb:
      return [buffer.readDoubleBE(offset + 1), offset + 9];
    case 0xcc:
      return [buffer.readUInt8(offset + 1), offset + 2];
    case 0xcd:
      return [buffer.readUInt16BE(offset + 1), offset + 3];
    case 0xce:
      return [buffer.readUInt32BE(offset + 1), offset + 5];
    case 0xcf:
      return [buffer.readBigUInt64BE(offset + 1), offset + 9];
    case 0xd0:
      return [buffer.readInt8(offset + 1), offset + 2];
    case 0xd1:
      return [buffer.readInt16BE(offset + 1), offset + 3];
    case 0xd2:
      return [buffer.readInt32BE(offset + 1), offset + 5];
    case 0xd3:
      return [buffer.readBigInt64BE(offset + 1), offset + 9];
    case 0xd9:
      return decodeString(buffer, offset + 2, buffer.readUInt8(offset + 1));
    case 0xda:
      return decodeString(buffer, offset + 3, buffer.readUInt16BE(offset + 1));
    case 0xdb:
      return decodeString(buffer, offset + 5, buffer.readUInt32BE(offset + 1));
    case 0xdc:
      return decodeArray(buffer, offset + 3, buffer.readUInt16BE(offset + 1));
    case 0xdd:
      return decodeArray(buffer, offset + 5, buffer.readUInt32BE(offset + 1));
    case 0xde:
      return decodeMap(buffer, offset + 3, buffer.readUInt16BE(offset + 1));
    case 0xdf:
      return decodeMap(buffer, offset + 5, buffer.readUInt32BE(offset + 1));
    default:
      throw new Error(
        `MessagePack type 0x${type.toString(16)} at ${offset} is not one dd-trace sends`,
      );
  }
}

function decodeString(
  buffer: Buffer,
  offset: number,
  length: number,
): [string, number] {
  return [buffer.toString("utf8", offset, offset + length), offset + length];
}

function decodeBytes(
  buffer: Buffer,
  offset: number,
  length: number,
): [Buffer, number] {
  return [buffer.subarray(offset, offset + length), offset + length];
}

function decodeArray(
  buffer: Buffer,
  offset: number,
  length: number,
): [unknown[], number] {
  const items: unknown[] = [];
  let next = offset;
  for (let i = 0; i < length; i++) {
    const [item, after] = decode(buffer, next);
    items.push(item);
    next = after;
  }
  return [items, next];
}

function decodeMap(
  buffer: Buffer,
  offset: number,
  length: number,
): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {};
  let next = offset;
  for (let i = 0; i < length; i++) {
    const [key, afterKey] = decode(buffer, next);
    const [value, afterValue] = decode(buffer, afterKey);
    map[String(key)] = value;
    next = afterValue;
  }
  return [map, next];
}
