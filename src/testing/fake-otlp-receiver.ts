import { createServer, IncomingHttpHeaders, Server } from "node:http";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import protobuf from "protobufjs";
import { listenOnLoopback, waitFor } from "./observe-harness.js";

/**
 * The OTLP trace schema, from the official `.proto` files vendored beside
 * this file (opentelemetry-proto v1.11.1), so a receiver decodes what the
 * exporter sends the way a real one would - not the way the exporter
 * thinks it should be read.
 */
const protoRoot = fileURLToPath(
  new URL("./opentelemetry-proto", import.meta.url),
);
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => `${protoRoot}/${target}`;
root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto");

export const ExportTraceServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

/** A span as it arrived, with ids in hex and attributes flattened. */
export interface ReceivedOtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number | boolean>;
  events?: Array<{ name: string; attributes: Record<string, unknown> }>;
  status?: { code?: number; message?: string };
  flags?: number;
}

export interface ReceivedOtlpExport {
  headers: IncomingHttpHeaders;
  encoding: "protobuf" | "json";
  resource: Record<string, string | number | boolean>;
  scope: { name?: string; version?: string };
  spans: ReceivedOtlpSpan[];
}

export interface FakeOtlpReceiver {
  /** The base URL, as `otlp.endpoint` takes it. */
  readonly url: string;
  /** Every export accepted, in order of arrival. */
  readonly exports: ReceivedOtlpExport[];
  /** Every request received, accepted or not. */
  readonly requests: Array<{ headers: IncomingHttpHeaders }>;
  spans(): ReceivedOtlpSpan[];
  /**
   * Answers the next request with this, then goes back to accepting. Queued:
   * two calls answer the next two requests.
   */
  answerNextWith(status: number, headers?: Record<string, string>): void;
  waitForSpan(
    predicate: (span: ReceivedOtlpSpan) => boolean,
    timeoutMs?: number,
  ): Promise<ReceivedOtlpSpan>;
  close(): Promise<void>;
}

type AnyValue = {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
};
type KeyValue = { key: string; value?: AnyValue };

const flatten = (attributes: KeyValue[] | undefined) =>
  Object.fromEntries(
    (attributes ?? []).map(({ key, value }) => [
      key,
      value?.stringValue ??
        value?.boolValue ??
        (value?.intValue !== undefined
          ? Number(value.intValue)
          : value?.doubleValue),
    ]),
  ) as Record<string, string | number | boolean>;

const bytesToHex = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (Array.isArray(value)) {
    return value.map(bytesToHex);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, bytesToHex(entry)]),
    );
  }
  return value;
};

/** Either encoding, read into one shape. */
function decodeExport(
  body: Buffer,
  contentType: string | undefined,
): Omit<ReceivedOtlpExport, "headers"> {
  const json = contentType?.includes("json") === true;
  const message = (
    json
      ? JSON.parse(body.toString("utf8"))
      : bytesToHex(
          ExportTraceServiceRequest.toObject(
            ExportTraceServiceRequest.decode(body),
            { longs: String, defaults: false },
          ),
        )
  ) as {
    resourceSpans?: Array<{
      resource?: { attributes?: KeyValue[] };
      scopeSpans?: Array<{
        scope?: { name?: string; version?: string };
        spans?: Array<
          Omit<ReceivedOtlpSpan, "attributes" | "events"> & {
            attributes?: KeyValue[];
            events?: Array<{ name: string; attributes?: KeyValue[] }>;
          }
        >;
      }>;
    }>;
  };
  const [resourceSpans] = message.resourceSpans ?? [];
  const [scopeSpans] = resourceSpans?.scopeSpans ?? [];
  return {
    encoding: json ? "json" : "protobuf",
    resource: flatten(resourceSpans?.resource?.attributes),
    scope: scopeSpans?.scope ?? {},
    spans: (scopeSpans?.spans ?? []).map((span) => ({
      ...span,
      attributes: flatten(span.attributes),
      events: span.events?.map((event) => ({
        ...event,
        attributes: flatten(event.attributes),
      })),
    })),
  };
}

/**
 * An OTLP/HTTP trace receiver on a free local port, which records every
 * export - gunzipped and decoded with the official schema - so a suite can
 * assert on the spans that left the process.
 */
export async function startFakeOtlpReceiver(): Promise<FakeOtlpReceiver> {
  const exports: ReceivedOtlpExport[] = [];
  const requests: Array<{ headers: IncomingHttpHeaders }> = [];
  const answers: Array<{ status: number; headers: Record<string, string> }> =
    [];

  const server: Server = createServer((req, res) => {
    requests.push({ headers: req.headers });
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const answer = answers.shift();
      if (answer) {
        res.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        res.end(JSON.stringify({ message: `answered ${answer.status}` }));
        return;
      }
      try {
        const raw = Buffer.concat(chunks);
        const body =
          req.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
        exports.push({
          headers: req.headers,
          ...decodeExport(body, req.headers["content-type"]),
        });
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(String(error));
        return;
      }
      // An empty ExportTraceServiceResponse, in the encoding asked in.
      const json = req.headers["content-type"]?.includes("json") === true;
      res.writeHead(200, {
        "content-type": json ? "application/json" : "application/x-protobuf",
      });
      res.end(json ? "{}" : undefined);
    });
  });

  const url = await listenOnLoopback(server);

  const spans = () => exports.flatMap((received) => received.spans);

  return {
    url,
    exports,
    requests,
    spans,
    answerNextWith(status, headers = {}) {
      answers.push({ status, headers });
    },
    async waitForSpan(predicate, timeoutMs = 8_000) {
      await waitFor(
        () => spans().some(predicate),
        timeoutMs,
        "a matching span to reach the OTLP receiver",
      );
      return spans().find(predicate)!;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
