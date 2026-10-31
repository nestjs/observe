import type { INestApplication } from "@nestjs/common";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import type {
  FakeCollector,
  WireSnapshot,
  WireSpan,
} from "./fake-collector.js";
import { waitFor } from "./observe-harness.js";
import type { ExportedSpan } from "./otlp-receiver.js";

/**
 * Shared steps for the suites that run the agent end to end beside
 * OpenTelemetry: the real worker sending to a fake collector, and the
 * services around the Nest one instrumented with the real SDK, exporting to
 * an OTLP receiver. What each tool recorded is read back where it landed -
 * the batch the collector received, the spans the receiver did - rather than
 * where it was produced.
 */

/** What `opentelemetry-service.cjs` answers with, at the end of the line. */
export interface ReceivedRequest {
  headers: Record<string, string>;
  rawHeaders: string[];
}

/** A W3C trace id written as Observe writes it: as a UUID. */
export const asUuid = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

/**
 * Sends requests to the app's `/health` until the collector has accepted a
 * batch from its worker. OpenTelemetry interop runs only from then on, so a
 * suite that asserts on it waits here first - as a deployed service's first
 * requests do.
 */
export async function untilIngesting(
  app: INestApplication,
  url: string,
  timeoutMs = 10_000,
): Promise<void> {
  const buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
  let n = 0;
  const traffic = setInterval(() => {
    fetch(`${url}/health?n=${n++}`)
      .then((response) => response.text())
      .catch(() => undefined);
  }, 200);
  try {
    await waitFor(
      () => buffer.isIngesting(),
      timeoutMs,
      "the collector to accept a first batch",
    );
  } finally {
    clearInterval(traffic);
  }
}

/** Waits for the snapshot matching `predicate` in a batch the collector received. */
export async function snapshotAt(
  collector: FakeCollector,
  predicate: (snapshot: WireSnapshot) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<WireSnapshot> {
  const find = () =>
    collector.batches.flatMap((batch) => batch.snapshots ?? []).find(predicate);
  await waitFor(() => find() !== undefined, timeoutMs, what);
  return find()!;
}

/** Every span of class `className` in a snapshot's tree, as sent. */
export function wireSpansOf(
  spans: WireSpan[] | undefined,
  className: string,
  found: WireSpan[] = [],
): WireSpan[] {
  for (const span of spans ?? []) {
    if (span.c === className) {
      found.push(span);
    }
    wireSpansOf(span.ch, className, found);
  }
  return found;
}

/** Where a suite reads spans from: an OTLP receiver, an in-process SDK. */
export type SpanSource = () => ExportedSpan[];

/** Waits for a span matching `predicate`, naming `what` if none comes. */
export async function spanFrom(
  source: SpanSource,
  predicate: (span: ExportedSpan) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<ExportedSpan> {
  const find = () => source().find(predicate);
  await waitFor(() => find() !== undefined, timeoutMs, what);
  return find()!;
}

/** A service's server span for a request to `path`. */
export const serverSpanFrom = (
  source: SpanSource,
  service: string,
  path: string,
): Promise<ExportedSpan> =>
  spanFrom(
    source,
    (span) =>
      span.service === service &&
      span.kind === "server" &&
      pathOf(span) === path,
    `the ${service} service's server span for ${path}`,
  );

/** The span a service opened for its one call out in a trace. */
export const clientSpanFrom = (
  source: SpanSource,
  service: string,
  traceId: string,
): Promise<ExportedSpan> =>
  spanFrom(
    source,
    (span) =>
      span.service === service &&
      span.kind === "client" &&
      span.traceId === traceId,
    `the ${service} service's client span in trace ${traceId}`,
  );

/** The path an HTTP span was for, under either generation of conventions. */
export const pathOf = (span: ExportedSpan): string => {
  const path = span.attributes["url.path"] ?? span.attributes["http.target"];
  return typeof path === "string" ? path.split("?")[0] : "";
};

/** How many times a header came - Node folds repeats into one value. */
export const countHeader = (rawHeaders: string[], name: string): number =>
  rawHeaders.filter(
    (value, index) => index % 2 === 0 && value.toLowerCase() === name,
  ).length;

const KINDS: ExportedSpan["kind"][] = [
  "internal",
  "server",
  "client",
  "producer",
  "consumer",
];

/** A span the SDK in a suite's own process kept, as the receiver has them. */
export const exportedSpanOf = (
  span: ReadableSpan,
  service: string,
): ExportedSpan => ({
  service,
  traceId: span.spanContext().traceId,
  spanId: span.spanContext().spanId,
  parentSpanId: span.parentSpanContext?.spanId,
  kind: KINDS[span.kind],
  name: span.name,
  attributes: { ...span.attributes },
});
