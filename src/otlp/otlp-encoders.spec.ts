import { fileURLToPath } from "url";
import protobuf from "protobufjs";
import { encodeOtlpJson, encodeOtlpProtobuf } from "./otlp-encoders.js";
import { OtlpSpan, SpanKind, STATUS_CODE_ERROR } from "./otlp-span.mapper.js";

/**
 * The encoders checked against the protocol's own definition rather than
 * against themselves: the protobuf bytes are decoded with the official
 * `.proto` files (vendored under src/testing, opentelemetry-proto v1.11.1)
 * by an independent decoder, and the JSON is compared against the same
 * decoded message - so a wrong field number, wire type or JSON field name
 * fails here, not at a customer's collector.
 */
const protoRoot = fileURLToPath(
  new URL("../testing/opentelemetry-proto", import.meta.url),
);
const root = new protobuf.Root();
root.resolvePath = (_origin, target) => `${protoRoot}/${target}`;
root.loadSync("opentelemetry/proto/collector/trace/v1/trace_service.proto", {
  keepCase: false,
});
const ExportTraceServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
);

/** Ids come back as bytes; written as hex, the way OTLP's JSON has them. */
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

const decode = (bytes: Buffer) =>
  bytesToHex(
    ExportTraceServiceRequest.toObject(
      ExportTraceServiceRequest.decode(bytes),
      { longs: String, defaults: false, oneofs: false },
    ),
  ) as {
    resourceSpans: Array<{
      resource: { attributes: Array<{ key: string; value: object }> };
      scopeSpans: Array<{
        scope: { name: string; version: string };
        spans: Array<Record<string, unknown>>;
      }>;
    }>;
  };

const scope = { name: "@nestjs/observe", version: "1.2.3" };
const resource = [
  { key: "service.name", value: "orders" },
  { key: "process.pid", value: 4242 },
];

// A nanosecond timestamp past 2^53, which a double cannot hold.
const START = 1_761_771_234_567_891_234n;

const server: OtlpSpan = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "b7ad6b7169203331",
  traceState: "vendor=abc",
  name: "GET /orders/:id",
  kind: SpanKind.SERVER,
  startTimeUnixNano: START,
  endTimeUnixNano: START + 12_500_000n,
  attributes: [
    { key: "http.request.method", value: "GET" },
    { key: "http.response.status_code", value: 500 },
    { key: "observe.ratio", value: 0.25 },
    { key: "observe.negative", value: -3 },
    { key: "observe.zero", value: 0 },
    { key: "observe.flag", value: false },
    { key: "observe.empty", value: "" },
    { key: "observe.unicode", value: "zamówienie ✓" },
  ],
  droppedAttributesCount: 2,
  events: [
    {
      timeUnixNano: START + 12_000_000n,
      name: "exception",
      attributes: [{ key: "exception.type", value: "TypeError" }],
    },
  ],
  status: { code: STATUS_CODE_ERROR, message: "boom" },
  flags: 0x301,
};

const child: OtlpSpan = {
  traceId: server.traceId,
  spanId: "a3ce929d0e0e4736",
  parentSpanId: server.spanId,
  name: "OrdersService.find",
  kind: SpanKind.INTERNAL,
  startTimeUnixNano: START + 1_000n,
  endTimeUnixNano: START + 2_000n,
  attributes: [],
  droppedAttributesCount: 0,
  events: [],
  flags: 0x101,
};

/** What both encodings should decode to, in protobufjs's JSON-ish shape. */
const expected = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "orders" } },
          { key: "process.pid", value: { intValue: "4242" } },
        ],
      },
      scopeSpans: [
        {
          scope,
          spans: [
            {
              traceId: server.traceId,
              spanId: server.spanId,
              traceState: "vendor=abc",
              parentSpanId: server.parentSpanId,
              name: "GET /orders/:id",
              kind: SpanKind.SERVER,
              startTimeUnixNano: START.toString(),
              endTimeUnixNano: (START + 12_500_000n).toString(),
              attributes: [
                { key: "http.request.method", value: { stringValue: "GET" } },
                {
                  key: "http.response.status_code",
                  value: { intValue: "500" },
                },
                { key: "observe.ratio", value: { doubleValue: 0.25 } },
                { key: "observe.negative", value: { intValue: "-3" } },
                { key: "observe.zero", value: { intValue: "0" } },
                { key: "observe.flag", value: { boolValue: false } },
                { key: "observe.empty", value: { stringValue: "" } },
                {
                  key: "observe.unicode",
                  value: { stringValue: "zamówienie ✓" },
                },
              ],
              droppedAttributesCount: 2,
              events: [
                {
                  timeUnixNano: (START + 12_000_000n).toString(),
                  name: "exception",
                  attributes: [
                    {
                      key: "exception.type",
                      value: { stringValue: "TypeError" },
                    },
                  ],
                },
              ],
              status: { code: STATUS_CODE_ERROR, message: "boom" },
              flags: 0x301,
            },
            {
              traceId: child.traceId,
              spanId: child.spanId,
              parentSpanId: child.parentSpanId,
              name: "OrdersService.find",
              kind: SpanKind.INTERNAL,
              startTimeUnixNano: (START + 1_000n).toString(),
              endTimeUnixNano: (START + 2_000n).toString(),
              flags: 0x101,
            },
          ],
        },
      ],
    },
  ],
};

describe("encodeOtlpProtobuf", () => {
  it("writes an ExportTraceServiceRequest the official schema decodes field for field", () => {
    const decoded = decode(
      encodeOtlpProtobuf(resource, scope, [server, child]),
    );

    expect(decoded).toEqual(expected);
  });

  it("keeps nanosecond timestamps exact past 2^53", () => {
    const decoded = decode(encodeOtlpProtobuf(resource, scope, [server]));

    expect(
      decoded.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano,
    ).toBe("1761771234567891234");
  });

  it("frames sub-messages of every length the prefix can take", () => {
    // A value long enough that its message's length needs a three-byte
    // varint, so the reserved prefix is closed up by different amounts at
    // different depths.
    const long = "x".repeat(70_000);
    const decoded = decode(
      encodeOtlpProtobuf(resource, scope, [
        { ...child, attributes: [{ key: "observe.long", value: long }] },
        server,
      ]),
    );
    const spans = decoded.resourceSpans[0].scopeSpans[0].spans;

    expect(spans).toHaveLength(2);
    expect(spans[0].attributes).toEqual([
      { key: "observe.long", value: { stringValue: long } },
    ]);
    expect(spans[1].name).toBe("GET /orders/:id");
  });

  it("writes a batch of a thousand spans", () => {
    const spans = Array.from({ length: 1000 }, (_, index) => ({
      ...child,
      spanId: index.toString(16).padStart(16, "1"),
      name: `span ${index}`,
    }));
    const decoded = decode(encodeOtlpProtobuf(resource, scope, spans));

    expect(
      decoded.resourceSpans[0].scopeSpans[0].spans.map((s) => s.name),
    ).toEqual(spans.map((span) => span.name));
  });
});

describe("encodeOtlpJson", () => {
  it("is the same message in OTLP's JSON encoding: hex ids, numeric enums, 64-bit values as strings", () => {
    const json = JSON.parse(
      encodeOtlpJson(resource, scope, [server, child]),
    ) as typeof expected;

    // Exactly what the protobuf decodes to, plus the fields protobufjs
    // leaves out when they hold their default.
    expect(json).toEqual({
      resourceSpans: [
        {
          ...expected.resourceSpans[0],
          scopeSpans: [
            {
              ...expected.resourceSpans[0].scopeSpans[0],
              spans: [
                expected.resourceSpans[0].scopeSpans[0].spans[0],
                {
                  ...expected.resourceSpans[0].scopeSpans[0].spans[1],
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("parses back into the schema's own message", () => {
    // protobufjs's fromObject is the JSON mapping's reader: field names the
    // schema does not know would be dropped, and the comparison would fail.
    const message = ExportTraceServiceRequest.fromObject(
      JSON.parse(encodeOtlpJson(resource, scope, [child])),
    );
    const roundTripped = ExportTraceServiceRequest.toObject(message, {
      longs: String,
      defaults: false,
    }) as {
      resourceSpans: Array<{
        scopeSpans: Array<{ spans: Array<{ name: string; kind: number }> }>;
      }>;
    };

    expect(roundTripped.resourceSpans[0].scopeSpans[0].spans[0]).toEqual(
      expect.objectContaining({ name: "OrdersService.find", kind: 1 }),
    );
  });
});
