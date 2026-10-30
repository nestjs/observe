import { defaultTraceIdGenerator } from "./default-trace-id-generator.util.js";

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

  it("joins the W3C trace a caller is in when it sends no x-request-id", () => {
    // What a service instrumented with OpenTelemetry sends: the trace id
    // comes back as a UUID, the shape of every id the agent mints.
    expect(
      defaultTraceIdGenerator({
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
  });

  it("prefers x-request-id to traceparent, which cannot carry every id", () => {
    // Another service running the agent sends both, and its trace id may be
    // a custom one only x-request-id holds - which is also what a proxy in
    // front of the service may already be setting.
    expect(
      defaultTraceIdGenerator({
        headers: {
          "x-request-id": "req_8f2c",
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      }),
    ).toBe("req_8f2c");
  });

  it("mints its own over a traceparent the spec would refuse", () => {
    const traceId = defaultTraceIdGenerator({
      headers: {
        traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      },
    });

    expect(traceId).toMatch(UUID);
    expect(traceId).not.toBe("00000000-0000-0000-0000-000000000000");
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
