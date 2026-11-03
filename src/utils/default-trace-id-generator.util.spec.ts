import {
  KafkaContext,
  MqttContext,
  NatsContext,
  RmqContext,
} from "@nestjs/microservices";
import {
  defaultTraceIdGenerator,
  openTelemetryTraceIdGenerator,
} from "./default-trace-id-generator.util.js";
import { w3cTraceIdOf } from "./trace-context.util.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("defaultTraceIdGenerator", () => {
  it("adopts an inbound x-request-id", () => {
    // Reusing the id the caller already assigned is what lets a trace be
    // followed across services rather than restarting at each hop.
    expect(
      defaultTraceIdGenerator({ headers: { "x-request-id": "upstream-1" } }),
    ).toBe("upstream-1");
  });

  it("generates a UUID when the header is absent", () => {
    expect(defaultTraceIdGenerator({ headers: {} })).toMatch(UUID);
  });

  it("generates a UUID for a request-like object with no headers", () => {
    expect(defaultTraceIdGenerator({})).toMatch(UUID);
  });

  it("generates a UUID for anything that is not a request", () => {
    // The generator also runs for jobs and RPC messages, which carry no headers
    // at all - it must never return undefined.
    for (const input of [undefined, null, "string", 42]) {
      expect(defaultTraceIdGenerator(input)).toMatch(UUID);
    }
  });

  it("does not repeat itself", () => {
    const ids = new Set(
      Array.from({ length: 500 }, () => defaultTraceIdGenerator({})),
    );

    // A collision would merge two unrelated traces into one.
    expect(ids.size).toBe(500);
  });

  it("ignores a traceparent, speaking x-request-id alone", () => {
    // With openTelemetry off, a request in a W3C trace is named as it always
    // was: by its x-request-id, else by a UUIDv7 minted here.
    const traceparent =
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const minted = defaultTraceIdGenerator({ headers: { traceparent } });

    expect(minted).toMatch(UUID);
    expect(minted).not.toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
    expect(
      defaultTraceIdGenerator({
        headers: { "x-request-id": "proxy-request-1", traceparent },
      }),
    ).toBe("proxy-request-1");
  });

  it("adopts the id a microservice client attached to the packet", () => {
    const ctx = { getMetadata: () => ({ "x-request-id": "rpc-trace-1" }) };

    expect(defaultTraceIdGenerator(ctx)).toBe("rpc-trace-1");
  });

  it("mints its own when the packet metadata is absent or implausible", () => {
    for (const metadata of [
      undefined,
      {},
      { "x-request-id": "x".repeat(500) },
    ]) {
      expect(defaultTraceIdGenerator({ getMetadata: () => metadata })).toMatch(
        /^[0-9a-f-]{36}$/,
      );
    }
  });
});

/**
 * Whether the installed `@nestjs/microservices` carries packet metadata over
 * the header transports. Their contexts gained `getMetadata()` in one
 * release, after TCP's and Redis's, so one of them stands for all four.
 */
const frameworkCarriesHeaderMetadata =
  typeof (NatsContext.prototype as { getMetadata?: unknown }).getMetadata ===
  "function";

/**
 * The contexts of the transports that carry packet metadata as headers, built
 * the way their servers build them. The generator's feature test is the only
 * thing that decides: the id the caller sent where the framework has
 * `getMetadata()`, a minted one where it does not.
 */
describe("defaultTraceIdGenerator: header-carried packet metadata", () => {
  const msgHdrs = (headers: Record<string, string>) => ({
    keys: () => Object.keys(headers),
    values: (key: string) => (key in headers ? [headers[key]] : []),
  });
  const contexts: [string, unknown][] = [
    [
      "NATS",
      new NatsContext([
        "orders.report",
        msgHdrs({ "x-request-id": "carried-1" }),
      ]),
    ],
    [
      "Kafka",
      new (KafkaContext as new (args: unknown[]) => KafkaContext)([
        { headers: { "x-request-id": Buffer.from("carried-1") } },
        0,
        "orders.report",
        {},
        async () => undefined,
        {},
        // What the server read off the raw headers
        { "x-request-id": "carried-1" },
      ]),
    ],
    [
      "RabbitMQ",
      new RmqContext([
        { properties: { headers: { "x-request-id": "carried-1" } } },
        {},
        "orders.report",
      ]),
    ],
    [
      "MQTT 5",
      new MqttContext([
        "orders/report",
        { properties: { userProperties: { "x-request-id": "carried-1" } } },
      ]),
    ],
  ];
  it.runIf(frameworkCarriesHeaderMetadata).each(contexts)(
    "adopts the id a %s client attached, where the framework carries it",
    (_transport, context) => {
      expect(defaultTraceIdGenerator(context)).toBe("carried-1");
      expect(openTelemetryTraceIdGenerator(context)).toBe("carried-1");
    },
  );

  it.runIf(!frameworkCarriesHeaderMetadata).each(contexts)(
    "mints an id of its own for %s, where the framework has no packet metadata",
    (_transport, context) => {
      expect(defaultTraceIdGenerator(context)).toMatch(UUID);
      expect(defaultTraceIdGenerator(context)).not.toBe("carried-1");
    },
  );

  it.runIf(frameworkCarriesHeaderMetadata)(
    "holds a header-carried id to the shape of an x-request-id header",
    () => {
      const context = new RmqContext([
        { properties: { headers: { "x-request-id": "not an id\n" } } },
        {},
        "orders.report",
      ]);

      expect(defaultTraceIdGenerator(context)).toMatch(UUID);
    },
  );
});

describe("openTelemetryTraceIdGenerator", () => {
  it("joins the W3C trace a caller is in when it sends no x-request-id", () => {
    // What a service instrumented with OpenTelemetry sends: the trace id
    // comes back as a UUID, the shape of every id the agent mints.
    expect(
      openTelemetryTraceIdGenerator({
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });

  it("lets a traceparent name the trace over an x-request-id that names another", () => {
    // What a mesh in front of an OpenTelemetry caller sends: Envoy stamps
    // every request with a request id of its own, unrelated to the trace.
    expect(
      openTelemetryTraceIdGenerator({
        headers: {
          "x-request-id": "6f1a52c4-3d0b-4e8a-9c2f-7b1d0e9a8c34",
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });

  it("keeps an x-request-id that names the same trace as the traceparent", () => {
    // Another service running the agent sends both. Its id may be one only
    // x-request-id holds - a custom id, whose traceparent carries a hash of
    // it - or a UUIDv7, whose mint time the collector reads.
    expect(
      openTelemetryTraceIdGenerator({
        headers: {
          "x-request-id": "req_8f2c",
          traceparent: `00-${w3cTraceIdOf("req_8f2c")}-00f067aa0ba902b7-01`,
        },
      }),
    ).toBe("req_8f2c");

    const minted = "019a3a7e-5c41-7d2e-8b6f-2c4d9e0a1b3c";
    expect(
      openTelemetryTraceIdGenerator({
        headers: {
          "x-request-id": minted,
          traceparent: `00-${minted.replace(/-/g, "")}-00f067aa0ba902b7-01`,
        },
      }),
    ).toBe(minted);
  });

  it("adopts x-request-id over a traceparent the spec would refuse", () => {
    expect(
      openTelemetryTraceIdGenerator({
        headers: {
          "x-request-id": "upstream-1",
          traceparent:
            "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
        },
      }),
    ).toBe("upstream-1");
  });

  it("mints its own over a traceparent the spec would refuse", () => {
    const traceId = openTelemetryTraceIdGenerator({
      headers: {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      },
    });

    expect(traceId).toMatch(UUID);
    expect(traceId).not.toBe("00000000-0000-0000-0000-000000000000");
  });

  it("names everything else as the default does", () => {
    expect(
      openTelemetryTraceIdGenerator({
        headers: { "x-request-id": "upstream-1" },
      }),
    ).toBe("upstream-1");
    expect(
      openTelemetryTraceIdGenerator({
        getMetadata: () => ({ "x-request-id": "rpc-trace-1" }),
      }),
    ).toBe("rpc-trace-1");
    expect(openTelemetryTraceIdGenerator({ headers: {} })).toMatch(UUID);
  });
});
