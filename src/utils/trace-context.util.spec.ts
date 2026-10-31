import {
  formatTraceparent,
  randomSpanId,
  readTraceContext,
  traceIdFromTraceparent,
  w3cSpanIdOf,
  w3cTraceIdOf,
} from "./trace-context.util.js";
import { uuidv7 } from "./uuid-v7.util.js";

// The example the W3C spec itself uses.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

describe("readTraceContext", () => {
  it("reads the trace, the caller's span and the sampled flag", () => {
    expect(readTraceContext({ traceparent: TRACEPARENT })).toEqual({
      traceId: TRACE_ID,
      parentSpanId: PARENT_ID,
      sampled: true,
    });
    expect(
      readTraceContext({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-00` })
        ?.sampled,
    ).toBe(false);
  });

  it("reads only the sampled bit of the flags", () => {
    // 0x03 is sampled plus Level 2's random-trace-id flag; 0x02 alone is
    // not sampled.
    expect(
      readTraceContext({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-03` })
        ?.sampled,
    ).toBe(true);
    expect(
      readTraceContext({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-02` })
        ?.sampled,
    ).toBe(false);
  });

  it("keeps the tracestate that came with it", () => {
    expect(
      readTraceContext({
        traceparent: TRACEPARENT,
        tracestate: " rojo=00f067aa0ba902b7, congo=t61rcWkgMzE ",
      })?.traceState,
    ).toBe("rojo=00f067aa0ba902b7, congo=t61rcWkgMzE");
  });

  it("follows a caller on a later version of the spec, ignoring what it added", () => {
    expect(
      readTraceContext({
        traceparent: `cc-${TRACE_ID}-${PARENT_ID}-01-what-the-future-holds`,
      }),
    ).toEqual({ traceId: TRACE_ID, parentSpanId: PARENT_ID, sampled: true });
  });

  it.each([
    ["no header", undefined],
    ["a repeated header, as Node folds it", `${TRACEPARENT}, ${TRACEPARENT}`],
    ["an array", [TRACEPARENT]],
    ["the reserved version ff", `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ["extra fields on version 00", `${TRACEPARENT}-extra`],
    ["an all-zero trace id", `00-${"0".repeat(32)}-${PARENT_ID}-01`],
    ["an all-zero parent id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["upper-case hex", TRACEPARENT.toUpperCase()],
    ["a short trace id", `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`],
    ["non-hex flags", `00-${TRACE_ID}-${PARENT_ID}-0g`],
    ["a bare trace id", TRACE_ID],
  ])("refuses %s", (_label, traceparent) => {
    expect(readTraceContext({ traceparent })).toBeUndefined();
  });

  it("drops a tracestate a header cannot carry, and never keeps one without a valid traceparent", () => {
    expect(
      readTraceContext({ traceparent: TRACEPARENT, tracestate: "a=1\r\nb=2" })
        ?.traceState,
    ).toBeUndefined();
    expect(
      readTraceContext({ traceparent: "garbage", tracestate: "a=1" }),
    ).toBeUndefined();
  });

  it("cuts an oversized tracestate at a whole entry", () => {
    const entries = Array.from(
      { length: 40 },
      (_, index) => `vendor${index}=${"v".repeat(20)}`,
    );
    const traceState = readTraceContext({
      traceparent: TRACEPARENT,
      tracestate: entries.join(","),
    })?.traceState;

    expect(traceState!.length).toBeLessThanOrEqual(512);
    expect(entries.join(",").startsWith(traceState!)).toBe(true);
    expect(traceState!.endsWith("v")).toBe(true);
  });
});

describe("traceIdFromTraceparent", () => {
  it("writes the trace id as a UUID, which w3cTraceIdOf turns straight back", () => {
    const traceId = traceIdFromTraceparent({ traceparent: TRACEPARENT });

    expect(traceId).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
    expect(w3cTraceIdOf(traceId!)).toBe(TRACE_ID);
  });

  it("is undefined without a valid traceparent", () => {
    expect(traceIdFromTraceparent({})).toBeUndefined();
    expect(traceIdFromTraceparent(undefined)).toBeUndefined();
  });
});

describe("w3cTraceIdOf", () => {
  it("maps a UUID onto the 128 bits it already is", () => {
    const id = uuidv7();
    expect(w3cTraceIdOf(id)).toBe(id.replace(/-/g, ""));
    expect(w3cTraceIdOf(id.toUpperCase())).toBe(id.replace(/-/g, ""));
  });

  it("keeps a 32-digit hex id, lower-cased", () => {
    expect(w3cTraceIdOf(TRACE_ID.toUpperCase())).toBe(TRACE_ID);
  });

  it("hashes any other id the same way every time, so every hop derives one trace", () => {
    const derived = w3cTraceIdOf("req_8f2c");

    expect(derived).toMatch(/^[0-9a-f]{32}$/);
    expect(w3cTraceIdOf("req_8f2c")).toBe(derived);
    expect(w3cTraceIdOf("req_8f2d")).not.toBe(derived);
  });

  it("never yields the all-zero id the spec forbids", () => {
    expect(w3cTraceIdOf("00000000-0000-0000-0000-000000000000")).not.toBe(
      "0".repeat(32),
    );
    expect(w3cTraceIdOf("0".repeat(32))).toMatch(/^(?!0{32})[0-9a-f]{32}$/);
  });
});

describe("w3cSpanIdOf", () => {
  it("takes the random low half of a UUIDv7, which spans minted together do not share", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_000);

    expect(w3cSpanIdOf(first)).toBe(first.replace(/-/g, "").slice(16));
    expect(w3cSpanIdOf(first)).not.toBe(w3cSpanIdOf(second));
  });

  it("hashes anything that is not a UUID", () => {
    expect(w3cSpanIdOf("span-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(w3cSpanIdOf("span-1")).toBe(w3cSpanIdOf("span-1"));
  });
});

describe("randomSpanId / formatTraceparent", () => {
  it("formats a version-00 header readTraceContext reads back", () => {
    const spanId = randomSpanId();
    const header = formatTraceparent(TRACE_ID, spanId, true);

    expect(header).toBe(`00-${TRACE_ID}-${spanId}-01`);
    expect(readTraceContext({ traceparent: header })).toEqual({
      traceId: TRACE_ID,
      parentSpanId: spanId,
      sampled: true,
    });
    expect(formatTraceparent(TRACE_ID, spanId, false).endsWith("-00")).toBe(
      true,
    );
  });
});
