import { uuidv7 } from "./uuid-v7.util.js";

const V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("mints a well-formed version 7 uuid", () => {
    expect(uuidv7()).toMatch(V7);
  });

  it("carries the minting time in its first 48 bits", () => {
    const at = Date.UTC(2026, 8, 12, 8, 2, 35, 404);

    const id = uuidv7(at);

    const stamp = parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(stamp).toBe(at);
  });

  it("orders by time and never repeats", () => {
    const earlier = uuidv7(1_000_000);
    const later = uuidv7(2_000_000);
    expect(earlier < later).toBe(true);

    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });

  it("stays well-formed and unique across refills of its random pool", () => {
    // The pool holds 1,024 ids' worth of random bytes; this crosses several
    // refills, including ids minted from the tail of one fill.
    const ids = Array.from({ length: 5000 }, () => uuidv7());

    expect(ids.every((id) => V7.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(5000);
  });
});
