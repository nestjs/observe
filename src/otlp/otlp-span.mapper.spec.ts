import type { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { w3cSpanIdOf } from "../utils/trace-context.util.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import {
  jobSnapshotSpans,
  OtlpSpan,
  requestSnapshotSpans,
  SpanKind,
  STATUS_CODE_ERROR,
} from "./otlp-span.mapper.js";

const CALLED_AT = "2026-10-29T12:00:00.000Z";
const START_NS = BigInt(Date.parse(CALLED_AT)) * 1_000_000n;
const ms = (value: number) => BigInt(Math.round(value * 1e6));

const attributesOf = (span: OtlpSpan) =>
  Object.fromEntries(span.attributes.map(({ key, value }) => [key, value]));

const ids = {
  controller: uuidv7(),
  service: uuidv7(),
  fetch: uuidv7(),
  query: uuidv7(),
  manual: uuidv7(),
};

/** A request as `pluckSnapshot` hands it over: controller, service, calls. */
function orderRequest(
  overrides: Partial<RequestSnapshot> = {},
): RequestSnapshot {
  return {
    traceId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    calledAt: CALLED_AT,
    duration: 42.5,
    protocol: "https",
    operationId: "/orders/:id",
    userId: "user-7",
    tags: { tenant: "acme" },
    attributes: {
      method: "GET",
      statusCode: 200,
      originalUrl: "/orders/7?expand=items&token=[REDACTED]",
    },
    traces: [
      {
        spanId: ids.controller,
        origin: "auto",
        className: "OrdersController",
        methodKey: "findOne",
        duration: 40,
        startOffset: 1,
        children: [
          {
            spanId: ids.service,
            origin: "auto",
            className: "OrdersService",
            methodKey: "findOne",
            duration: 30,
            startOffset: 2.25,
            children: [
              {
                spanId: ids.fetch,
                origin: "auto",
                className: "http",
                methodKey: "GET api.stripe.com",
                duration: 12,
                startOffset: 3,
                tags: {
                  "http.method": "GET",
                  "http.url": "https://api.stripe.com/v1/charges/ch_1",
                },
              },
              {
                spanId: ids.query,
                origin: "auto",
                className: "pg",
                methodKey: "SELECT orders",
                duration: 5,
                startOffset: 16,
                tags: {
                  "db.system": "postgresql",
                  "db.statement": 'SELECT "id" FROM "orders" WHERE "id" = $1',
                },
              },
              {
                spanId: ids.manual,
                name: "price items",
                origin: "manual",
                className: "OrdersService",
                methodKey: "findOne",
                duration: 4,
                startOffset: 22,
                tags: { items: 3 },
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  } as RequestSnapshot;
}

describe("requestSnapshotSpans", () => {
  it("puts a SERVER span for the request over its tree, parents linked by span id", () => {
    const spans = requestSnapshotSpans(orderRequest(), undefined);
    const [server, controller, service, fetchSpan, query, manual] = spans;

    expect(spans).toHaveLength(6);
    expect(new Set(spans.map((span) => span.traceId))).toEqual(
      new Set(["0193a1b2c3d47e5f8a9b0c1d2e3f4a5b"]),
    );
    expect(server.parentSpanId).toBeUndefined();
    expect(controller.parentSpanId).toBe(server.spanId);
    expect(service.parentSpanId).toBe(controller.spanId);
    for (const leaf of [fetchSpan, query, manual]) {
      expect(leaf.parentSpanId).toBe(service.spanId);
    }
    // The agent's own span ids, so a downstream service's server span -
    // whose traceparent named this call - nests under the client span.
    expect(controller.spanId).toBe(w3cSpanIdOf(ids.controller));
    expect(fetchSpan.spanId).toBe(w3cSpanIdOf(ids.fetch));
  });

  it("names and kinds the spans: route, Class.method, what a call did", () => {
    const [server, controller, , fetchSpan, query, manual] =
      requestSnapshotSpans(orderRequest(), undefined);

    expect([server.name, server.kind]).toEqual([
      "GET /orders/:id",
      SpanKind.SERVER,
    ]);
    expect([controller.name, controller.kind]).toEqual([
      "OrdersController.findOne",
      SpanKind.INTERNAL,
    ]);
    expect([fetchSpan.name, fetchSpan.kind]).toEqual([
      "GET api.stripe.com",
      SpanKind.CLIENT,
    ]);
    expect([query.name, query.kind]).toEqual([
      "SELECT orders",
      SpanKind.CLIENT,
    ]);
    expect([manual.name, manual.kind]).toEqual([
      "price items",
      SpanKind.INTERNAL,
    ]);
  });

  it("places every span on the trace's clock by its offset", () => {
    const [server, controller, service, fetchSpan] = requestSnapshotSpans(
      orderRequest(),
      undefined,
    );

    expect(server.startTimeUnixNano).toBe(START_NS);
    expect(server.endTimeUnixNano).toBe(START_NS + ms(42.5));
    expect(controller.startTimeUnixNano).toBe(START_NS + ms(1));
    expect(service.startTimeUnixNano).toBe(START_NS + ms(2.25));
    expect(service.endTimeUnixNano).toBe(START_NS + ms(2.25) + ms(30));
    expect(fetchSpan.startTimeUnixNano).toBe(START_NS + ms(3));
  });

  it("describes the request with the HTTP conventions, and keeps the agent's tags", () => {
    const [server] = requestSnapshotSpans(
      orderRequest({
        attributes: {
          method: "POST",
          statusCode: 201,
          originalUrl: "/orders?draft=1",
          defaultOperationId: "/orders",
        },
        operationId: "create-order",
        request: { headers: { "User-Agent": "curl/8" } },
      }),
      undefined,
    );

    expect(server.name).toBe("POST create-order");
    expect(attributesOf(server)).toEqual({
      tenant: "acme",
      "http.request.method": "POST",
      "http.route": "/orders",
      "http.response.status_code": 201,
      "url.scheme": "https",
      "url.path": "/orders",
      "url.query": "draft=1",
      "enduser.id": "user-7",
      "http.request.header.user-agent": "curl/8",
    });
    expect(server.status).toBeUndefined();
  });

  it("adds the stable conventions' names beside the ones the integrations write", () => {
    const [, , , fetchSpan, query] = requestSnapshotSpans(
      orderRequest(),
      undefined,
    );

    expect(attributesOf(fetchSpan)).toEqual({
      "http.method": "GET",
      "http.url": "https://api.stripe.com/v1/charges/ch_1",
      "http.request.method": "GET",
      "url.full": "https://api.stripe.com/v1/charges/ch_1",
      "server.address": "api.stripe.com",
      "server.port": 443,
    });
    expect(attributesOf(query)).toEqual(
      expect.objectContaining({
        "db.system": "postgresql",
        "db.query.text": 'SELECT "id" FROM "orders" WHERE "id" = $1',
      }),
    );
    expect(attributesOf(query)).not.toHaveProperty("code.function.name");
  });

  it("names the provider method a span stands for", () => {
    const [, controller, , , , manual] = requestSnapshotSpans(
      orderRequest(),
      undefined,
    );

    expect(attributesOf(controller)["code.function.name"]).toBe(
      "OrdersController.findOne",
    );
    // A manual span sits in the method that opened it.
    expect(attributesOf(manual)).toEqual({
      "code.function.name": "OrdersService.findOne",
      items: 3,
    });
  });

  it("goes under the caller's span, and keeps its tracestate, when the request came with a traceparent", () => {
    const spans = requestSnapshotSpans(orderRequest(), {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      sampled: true,
      traceState: "vendor=abc",
    });
    const [server, controller] = spans;

    expect(server.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(server.parentSpanId).toBe("00f067aa0ba902b7");
    expect(server.traceState).toBe("vendor=abc");
    // Sampled, with a remote parent; everything below has a local one.
    expect(server.flags).toBe(0x301);
    expect(controller.flags).toBe(0x101);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
  });

  it("marks a server error, records its exception where it was thrown, and leaves a 4xx unset", () => {
    const error = {
      cls: "TypeError",
      message: "items is not iterable",
      stack: "TypeError: items is not iterable\n    at OrdersService.findOne",
    };
    const failing = orderRequest({
      error,
      attributes: { method: "GET", statusCode: 500, originalUrl: "/orders/7" },
    });
    (failing.traces[0] as { error?: unknown }).error = error;
    const [server, controller] = requestSnapshotSpans(failing, undefined);

    expect(server.status).toEqual({
      code: STATUS_CODE_ERROR,
      message: "items is not iterable",
    });
    expect(attributesOf(server)["error.type"]).toBe("TypeError");
    expect(server.events).toEqual([]);
    expect(controller.status?.code).toBe(STATUS_CODE_ERROR);
    expect(controller.events).toEqual([
      {
        timeUnixNano: controller.endTimeUnixNano,
        name: "exception",
        attributes: [
          { key: "exception.type", value: "TypeError" },
          { key: "exception.message", value: "items is not iterable" },
          { key: "exception.stacktrace", value: error.stack },
        ],
      },
    ]);

    const [notFound] = requestSnapshotSpans(
      orderRequest({
        error: { cls: "NotFoundException", message: "no order" },
        attributes: { method: "GET", statusCode: 404 },
      }),
      undefined,
    );
    expect(notFound.status).toBeUndefined();
    expect(attributesOf(notFound)["error.type"]).toBe("NotFoundException");
  });

  it("fails a transport with no status of its own on its error alone", () => {
    const [server] = requestSnapshotSpans(
      orderRequest({
        protocol: "TCP",
        operationId: '{"cmd":"sum"}',
        attributes: undefined,
        error: { message: "boom" },
        traces: [],
      }),
      undefined,
    );

    expect(server.name).toBe('{"cmd":"sum"}');
    expect(server.status?.code).toBe(STATUS_CODE_ERROR);
    expect(attributesOf(server)).toEqual(
      expect.objectContaining({
        "rpc.system": "tcp",
        "rpc.method": '{"cmd":"sum"}',
      }),
    );
  });

  it("reads a GraphQL document where a request has its URL", () => {
    const [server] = requestSnapshotSpans(
      orderRequest({
        protocol: "http",
        operationId: "Query.orders",
        attributes: {
          method: "POST",
          statusCode: 200,
          originalUrl: "{ orders { id } }",
        },
        traces: [],
      }),
      undefined,
    );

    expect(attributesOf(server)).toEqual(
      expect.objectContaining({
        "graphql.document": "{ orders { id } }",
        "http.route": "Query.orders",
      }),
    );
    expect(attributesOf(server)).not.toHaveProperty("url.path");
  });

  it("leaves out a span still open, with everything under it", () => {
    const snapshot = orderRequest();
    (snapshot.traces as unknown[]).push({
      type: "start",
      origin: "auto",
      className: "Leaky",
      methodKey: "run",
      startTime: 1,
      children: [],
    });

    expect(requestSnapshotSpans(snapshot, undefined)).toHaveLength(6);
  });

  it("mints span ids for nodes that carry none, and a fresh server span id every time", () => {
    const snapshot = orderRequest({
      traces: [
        {
          origin: "auto",
          className: "LegacyNode",
          methodKey: "run",
          duration: 1,
          children: [],
        },
      ],
    });
    const first = requestSnapshotSpans(snapshot, undefined);
    const second = requestSnapshotSpans(snapshot, undefined);

    expect(first[1].spanId).toMatch(/^[0-9a-f]{16}$/);
    // Two requests can share a trace id; their server spans must not share
    // an id.
    expect(first[0].spanId).not.toBe(second[0].spanId);
    // A node from an agent older than startOffset starts with the request.
    expect(first[1].startTimeUnixNano).toBe(START_NS);
  });

  it("caps a span's attributes and counts the rest", () => {
    const tags = Object.fromEntries(
      Array.from({ length: 140 }, (_, index) => [`tag.${index}`, index]),
    );
    const [server] = requestSnapshotSpans(
      orderRequest({ tags, traces: [] }),
      undefined,
    );

    expect(server.attributes).toHaveLength(128);
    expect(server.droppedAttributesCount).toBeGreaterThan(0);
  });
});

describe("jobSnapshotSpans", () => {
  const job = (overrides: Partial<JobSnapshot> = {}): JobSnapshot =>
    ({
      id: "42",
      traceId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
      name: "send-receipt",
      queueName: "emails",
      status: "completed",
      calledAt: CALLED_AT,
      duration: 8,
      attemptsMade: 1,
      maxAttempts: 3,
      waitDuration: 120,
      traces: [
        {
          spanId: uuidv7(),
          origin: "auto",
          className: "ReceiptsProcessor",
          methodKey: "process",
          duration: 7,
          startOffset: 0.5,
        },
      ],
      ...overrides,
    }) as JobSnapshot;

  it("is a CONSUMER span for a queue job, in the trace of the request that enqueued it", () => {
    const [run, processor] = jobSnapshotSpans(job());

    expect(run).toEqual(
      expect.objectContaining({
        traceId: "0193a1b2c3d47e5f8a9b0c1d2e3f4a5b",
        name: "emails send-receipt",
        kind: SpanKind.CONSUMER,
        startTimeUnixNano: START_NS,
        endTimeUnixNano: START_NS + ms(8),
      }),
    );
    expect(run.parentSpanId).toBeUndefined();
    expect(attributesOf(run)).toEqual(
      expect.objectContaining({
        "messaging.operation.type": "process",
        "messaging.destination.name": "emails",
        "messaging.message.id": "42",
        "observe.job.attempts_made": 1,
        "observe.job.wait_ms": 120,
      }),
    );
    expect(processor.parentSpanId).toBe(run.spanId);
    expect(processor.name).toBe("ReceiptsProcessor.process");
  });

  it("is an INTERNAL span for a scheduled run, which nothing sent", () => {
    const [run] = jobSnapshotSpans(
      job({ queueName: "cron", name: "ReportsService.nightly" }),
    );

    expect(run.kind).toBe(SpanKind.INTERNAL);
    expect(attributesOf(run)).not.toHaveProperty("messaging.destination.name");
  });

  it("fails with the job", () => {
    const [run] = jobSnapshotSpans(
      job({ status: "failed", error: { cls: "Error", message: "SMTP down" } }),
    );

    expect(run.status).toEqual({
      code: STATUS_CODE_ERROR,
      message: "SMTP down",
    });
    expect(attributesOf(run)["error.type"]).toBe("Error");
  });
});
