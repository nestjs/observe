import type { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import type {
  CompleteTraceEventNode,
  OngoingTraceEventNode,
} from "../interfaces/trace-events.interfaces.js";
import {
  randomSpanId,
  TraceContext,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "../utils/trace-context.util.js";
import type { OtlpAttributeValue } from "./otlp-settings.util.js";

/** OTLP's `Span.SpanKind`. */
export const SpanKind = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  CONSUMER: 5,
} as const;

/** OTLP's `Status.StatusCode`. Only errors are ever set. */
export const STATUS_CODE_ERROR = 2;

/**
 * `Span.flags`: the W3C trace flags in the low byte - every exported span
 * was recorded, so `sampled` - and whether the parent is remote, which
 * OTLP 1.2 added so a backend can tell a process boundary from a local
 * call without guessing.
 */
const SAMPLED_FLAG = 0x01;
const HAS_IS_REMOTE_FLAG = 0x100;
const IS_REMOTE_FLAG = 0x200;
const LOCAL_PARENT_FLAGS = SAMPLED_FLAG | HAS_IS_REMOTE_FLAG;
const REMOTE_PARENT_FLAGS = LOCAL_PARENT_FLAGS | IS_REMOTE_FLAG;

/**
 * Most attributes one span carries; the rest are counted as dropped. The
 * OpenTelemetry SDKs' default limit.
 */
const MAX_ATTRIBUTES_PER_SPAN = 128;

/**
 * The span classes the outgoing integrations open - see
 * `OutgoingSpanRecorder.open` - which are calls out of the process: CLIENT
 * spans, named for what they did (`GET api.stripe.com`, `SELECT orders`)
 * rather than for a class and method.
 */
const CLIENT_SPAN_CLASSES = new Set([
  "http",
  "pg",
  "mysql2",
  "mongodb",
  "mssql",
]);

/**
 * The queue names a scheduled handler reports under - see
 * `ScheduleObserveAgentService` - for a run that nothing sent: INTERNAL,
 * where a queue job is a CONSUMER.
 */
const SCHEDULER_QUEUES = new Set(["cron", "interval", "timeout", "schedule"]);

/**
 * Tags the agent's own integrations write under pre-1.0 semantic convention
 * names, beside the names the stable conventions settled on, so a backend
 * reading either finds them.
 */
const STABLE_CONVENTION_NAMES: Record<string, string> = {
  "http.method": "http.request.method",
  "http.url": "url.full",
  "db.statement": "db.query.text",
};

export interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

export interface OtlpEvent {
  timeUnixNano: bigint;
  name: string;
  attributes: OtlpAttribute[];
}

/** One span, ready for either encoder. Ids are lowercase hex. */
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceState?: string;
  name: string;
  kind: (typeof SpanKind)[keyof typeof SpanKind];
  startTimeUnixNano: bigint;
  endTimeUnixNano: bigint;
  attributes: OtlpAttribute[];
  droppedAttributesCount: number;
  events: OtlpEvent[];
  status?: { code: typeof STATUS_CODE_ERROR; message?: string };
  flags: number;
}

type ErrorPayload = NonNullable<RequestSnapshot["error"]>;
type TraceNode = CompleteTraceEventNode | OngoingTraceEventNode;

/**
 * A request, a GraphQL operation, an RPC message or a gateway message as
 * OTLP spans: one SERVER span for the operation, and under it a span for
 * every node of its tree.
 *
 * The SERVER span is what the agent's own snapshot has no node for - the
 * operation itself, with its route, status and user - and gets an id of its
 * own, minted here: several requests can share a trace id (a caller that
 * fans out), and anything derived from it would give them all one span. It
 * goes under the caller's span when the request arrived with a
 * `traceparent`, which is what joins it to the trace upstream.
 */
export function requestSnapshotSpans(
  snapshot: RequestSnapshot,
  context: TraceContext | undefined,
): OtlpSpan[] {
  const traceId = context?.traceId ?? w3cTraceIdOf(snapshot.traceId);
  const startNs = epochNanos(snapshot.calledAt);
  const statusCode = snapshot.attributes?.statusCode;
  const method = snapshot.attributes?.method;

  const tags: Record<string, OtlpAttributeValue | undefined> = {
    ...snapshot.tags,
    ...requestConventionAttributes(snapshot),
    "enduser.id": snapshot.userId,
    "error.type":
      snapshot.error?.cls ??
      (statusCode !== undefined && statusCode >= 500
        ? String(statusCode)
        : undefined),
  };
  for (const [name, value] of Object.entries(snapshot.request?.headers ?? {})) {
    tags[`http.request.header.${name.toLowerCase()}`] = value;
  }

  // A 4xx is the caller's mistake, not the server's: the HTTP conventions
  // leave such a server span's status unset. Transports with no status of
  // their own fail on the error alone.
  const failed =
    statusCode !== undefined ? statusCode >= 500 : snapshot.error !== undefined;
  const server: OtlpSpan = {
    traceId,
    spanId: randomSpanId(),
    ...(context
      ? { parentSpanId: context.parentSpanId, traceState: context.traceState }
      : {}),
    name:
      [method, snapshot.operationId].filter(Boolean).join(" ") ||
      snapshot.protocol,
    kind: SpanKind.SERVER,
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs + millisToNanos(snapshot.duration ?? 0),
    ...toAttributes(tags),
    events: [],
    ...(failed ? { status: errorStatus(snapshot.error) } : {}),
    flags: context ? REMOTE_PARENT_FLAGS : LOCAL_PARENT_FLAGS,
  };

  const spans = [server];
  for (const node of snapshot.traces ?? []) {
    appendNodeSpans(spans, node, traceId, server.spanId, startNs);
  }
  return spans;
}

/**
 * A queue job or a scheduled run as OTLP spans: a CONSUMER span for the run
 * - INTERNAL for a scheduled one, which nothing sent - and its tree under
 * it. A job reports under the trace id of the operation that enqueued it,
 * so it lands in that trace; nothing records which span enqueued it, so it
 * has no parent there.
 */
export function jobSnapshotSpans(snapshot: JobSnapshot): OtlpSpan[] {
  const traceId = w3cTraceIdOf(snapshot.traceId);
  const startNs = epochNanos(snapshot.calledAt);
  const scheduled = SCHEDULER_QUEUES.has(snapshot.queueName);

  const tags: Record<string, OtlpAttributeValue | undefined> = {
    ...snapshot.tags,
    "observe.job.name": snapshot.name,
    "observe.job.queue": snapshot.queueName,
    "observe.job.attempts_made": snapshot.attemptsMade,
    "observe.job.max_attempts": snapshot.maxAttempts,
    "observe.job.wait_ms": snapshot.waitDuration,
    "error.type": snapshot.error?.cls,
  };
  if (!scheduled) {
    tags["messaging.operation.type"] = "process";
    tags["messaging.destination.name"] = snapshot.queueName;
    tags["messaging.message.id"] = snapshot.id;
  }

  const failed =
    snapshot.status === "failed" ||
    (snapshot.status === undefined && snapshot.error !== undefined);
  const run: OtlpSpan = {
    traceId,
    spanId: randomSpanId(),
    name: `${snapshot.queueName} ${snapshot.name}`,
    kind: scheduled ? SpanKind.INTERNAL : SpanKind.CONSUMER,
    startTimeUnixNano: startNs,
    endTimeUnixNano: startNs + millisToNanos(snapshot.duration ?? 0),
    ...toAttributes(tags),
    events: [],
    ...(failed ? { status: errorStatus(snapshot.error) } : {}),
    flags: LOCAL_PARENT_FLAGS,
  };

  const spans = [run];
  for (const node of snapshot.traces ?? []) {
    appendNodeSpans(spans, node, traceId, run.spanId, startNs);
  }
  return spans;
}

/**
 * One node of an operation's tree and everything below it, depth first.
 *
 * A node's span id is the low half of its Observe span id - the same id an
 * outbound call put in its `traceparent` - so the server span a downstream
 * service exports nests under the client span exported here.
 *
 * Placed on the clock by `startOffset`, the node's start relative to the
 * operation's, which is what lets overlapping calls overlap. A node from an
 * agent older than that field starts with the operation. A node still open
 * is not exported: the registry ships a tree only once its spans closed, or
 * without the ones that never did.
 */
function appendNodeSpans(
  spans: OtlpSpan[],
  node: TraceNode,
  traceId: string,
  parentSpanId: string,
  operationStartNs: bigint,
): void {
  if ("type" in node && node.type === "start") {
    return;
  }
  const complete = node as CompleteTraceEventNode;
  const client =
    complete.origin === "auto" && CLIENT_SPAN_CLASSES.has(complete.className);
  const startNs = operationStartNs + millisToNanos(complete.startOffset ?? 0);
  const endNs = startNs + millisToNanos(complete.duration ?? 0);

  const tags: Record<string, OtlpAttributeValue | undefined> = {
    ...(client
      ? {}
      : {
          "code.function.name": `${complete.className}.${complete.methodKey}`,
        }),
    ...complete.tags,
  };
  for (const [legacy, stable] of Object.entries(STABLE_CONVENTION_NAMES)) {
    if (tags[legacy] !== undefined && tags[stable] === undefined) {
      tags[stable] = tags[legacy];
    }
  }
  if (client && complete.className === "http") {
    Object.assign(tags, serverAddress(tags["url.full"]));
  }

  const error = typeof complete.error === "object" ? complete.error : undefined;
  const span: OtlpSpan = {
    traceId,
    spanId: complete.spanId ? w3cSpanIdOf(complete.spanId) : randomSpanId(),
    parentSpanId,
    name:
      complete.name ??
      (client
        ? complete.methodKey
        : `${complete.className}.${complete.methodKey}`),
    kind: client ? SpanKind.CLIENT : SpanKind.INTERNAL,
    startTimeUnixNano: startNs,
    endTimeUnixNano: endNs,
    ...toAttributes({ ...tags, "error.type": error?.cls }),
    events: error ? [exceptionEvent(error, endNs)] : [],
    ...(complete.error ? { status: errorStatus(error) } : {}),
    flags: LOCAL_PARENT_FLAGS,
  };
  spans.push(span);

  for (const child of complete.children ?? []) {
    appendNodeSpans(spans, child, traceId, span.spanId, operationStartNs);
  }
}

/**
 * The HTTP semantic conventions for a request that came in over HTTP. A
 * GraphQL operation carries its document where a request carries its URL,
 * which is told apart by not starting with a slash.
 */
function requestConventionAttributes(
  snapshot: RequestSnapshot,
): Record<string, OtlpAttributeValue | undefined> {
  const { protocol, operationId, attributes } = snapshot;
  const http = protocol === "http" || protocol === "https";
  const originalUrl = attributes?.originalUrl;
  const document =
    originalUrl !== undefined && !originalUrl.startsWith("/")
      ? originalUrl
      : undefined;
  const [path, query] =
    originalUrl !== undefined && document === undefined
      ? splitOnce(originalUrl, "?")
      : [undefined, undefined];

  if (http) {
    return {
      "http.request.method": attributes?.method,
      // The name the request would have had: `setOperationId` renames it
      // for the dashboard, not the route it matched.
      "http.route": attributes?.defaultOperationId ?? operationId,
      "http.response.status_code": attributes?.statusCode,
      "url.scheme": protocol,
      "url.path": path,
      "url.query": query,
      "graphql.document": document,
    };
  }
  if (protocol === "graphql" || protocol === "ws") {
    return {
      "observe.operation_id": operationId,
      "observe.status_code": attributes?.statusCode,
      "graphql.document": document,
    };
  }
  // A microservice transport (TCP, NATS, Kafka, gRPC, ...).
  return {
    "rpc.system": protocol.toLowerCase(),
    "rpc.method": operationId,
    "observe.status_code": attributes?.statusCode,
  };
}

/** `server.address` and `server.port` of a client call's URL. */
function serverAddress(
  url: OtlpAttributeValue | undefined,
): Record<string, OtlpAttributeValue> {
  if (typeof url !== "string") {
    return {};
  }
  try {
    const { hostname, port, protocol } = new URL(url);
    return {
      "server.address": hostname,
      "server.port": port ? Number(port) : protocol === "https:" ? 443 : 80,
    };
  } catch {
    return {};
  }
}

/**
 * An error as the exception event the semantic conventions define - the
 * same class, message and stack the dashboard shows, redacted as they were
 * for it. Placed at the span's end: the agent learns of an error when the
 * call that raised it returns.
 */
function exceptionEvent(error: ErrorPayload, timeUnixNano: bigint): OtlpEvent {
  return {
    timeUnixNano,
    name: "exception",
    attributes: toAttributes({
      "exception.type": error.cls,
      "exception.message": error.message,
      "exception.stacktrace": error.stack,
    }).attributes,
  };
}

function errorStatus(
  error: ErrorPayload | undefined,
): NonNullable<OtlpSpan["status"]> {
  return error?.message
    ? { code: STATUS_CODE_ERROR, message: error.message }
    : { code: STATUS_CODE_ERROR };
}

/**
 * Attributes from a flat record, in its order, without the keys that hold
 * nothing - and at most `MAX_ATTRIBUTES_PER_SPAN` of them, the rest counted.
 */
export function toAttributes(
  record: Record<string, OtlpAttributeValue | undefined | null>,
): { attributes: OtlpAttribute[]; droppedAttributesCount: number } {
  const attributes: OtlpAttribute[] = [];
  let droppedAttributesCount = 0;
  for (const [key, value] of Object.entries(record)) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === "number" && !Number.isFinite(value))
    ) {
      continue;
    }
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    if (attributes.length >= MAX_ATTRIBUTES_PER_SPAN) {
      droppedAttributesCount += 1;
      continue;
    }
    attributes.push({ key, value });
  }
  return { attributes, droppedAttributesCount };
}

/**
 * Unix nanoseconds for an ISO timestamp. Whole milliseconds, as `calledAt`
 * is written, so the product stays exact in a BigInt where a double would
 * already have lost the nanoseconds.
 */
function epochNanos(iso: string | undefined): bigint {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso);
  return BigInt(Number.isFinite(ms) ? ms : Date.now()) * 1_000_000n;
}

/**
 * Nanoseconds for a duration or offset in milliseconds - small enough, unlike
 * an epoch time, for a double to carry to the nanosecond.
 */
function millisToNanos(ms: number): bigint {
  return Number.isFinite(ms) && ms > 0 ? BigInt(Math.round(ms * 1e6)) : 0n;
}

function splitOnce(
  value: string,
  separator: string,
): [string, string | undefined] {
  const index = value.indexOf(separator);
  return index === -1
    ? [value, undefined]
    : [value.slice(0, index), value.slice(index + 1)];
}
