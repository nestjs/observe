import { createServer, Server } from "node:http";
import { listenOnLoopback } from "./observe-harness.js";

/** A span as an OpenTelemetry backend sees it, whichever process sent it. */
export interface ExportedSpan {
  /** `service.name` of the process that exported it. */
  service: string;
  traceId: string;
  spanId: string;
  /** Absent on a span that started its trace. */
  parentSpanId?: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer";
  name: string;
  attributes: Record<string, unknown>;
}

export interface OtlpReceiver {
  /** What to hand an exporter as its traces endpoint. */
  readonly tracesUrl: string;
  /** Every span received, in order of arrival. */
  readonly spans: ExportedSpan[];
  close(): Promise<void>;
}

// OTLP's SpanKind, which counts from UNSPECIFIED: one ahead of the API's.
const KINDS: Record<number, ExportedSpan["kind"]> = {
  1: "internal",
  2: "server",
  3: "client",
  4: "producer",
  5: "consumer",
};

interface OtlpAttribute {
  key: string;
  value: Record<string, unknown>;
}

interface OtlpRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: OtlpAttribute[] };
    scopeSpans?: Array<{
      spans?: Array<{
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        name: string;
        kind: number;
        attributes?: OtlpAttribute[];
      }>;
    }>;
  }>;
}

const attributesOf = (attributes: OtlpAttribute[] = []) =>
  Object.fromEntries(
    attributes.map(({ key, value }) => [key, Object.values(value)[0]]),
  );

/**
 * An OpenTelemetry backend on a free local port, as far as the services in a
 * suite can tell: it takes OTLP/HTTP in JSON - what
 * `@opentelemetry/exporter-trace-otlp-http` sends, and what
 * `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` selects - and keeps every span, so
 * a suite can ask which trace each service put its part of a request in.
 */
export async function startOtlpReceiver(): Promise<OtlpReceiver> {
  const spans: ExportedSpan[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(
          Buffer.concat(chunks).toString(),
        ) as OtlpRequest;
        for (const resourceSpans of body.resourceSpans ?? []) {
          const service = String(
            attributesOf(resourceSpans.resource?.attributes)["service.name"],
          );
          for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
            for (const span of scopeSpans.spans ?? []) {
              spans.push({
                service,
                traceId: span.traceId,
                spanId: span.spanId,
                parentSpanId: span.parentSpanId || undefined,
                kind: KINDS[span.kind] ?? "internal",
                name: span.name,
                attributes: attributesOf(span.attributes),
              });
            }
          }
        }
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });

  const url = await listenOnLoopback(server);

  return {
    tracesUrl: `${url}/v1/traces`,
    spans,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
