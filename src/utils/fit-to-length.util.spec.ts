import * as crypto from "crypto";
import { fitToLength } from "./fit-to-length.util.js";

/** Every hash `fitToLength` takes, by how much of the value it reads. */
const hashed = vi.hoisted(() => [] as number[]);
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof crypto>();
  return {
    ...actual,
    createHash: (algorithm: string) => {
      const hash = actual.createHash(algorithm);
      const update = hash.update.bind(hash);
      let read = 0;
      hashed.push(0);
      const at = hashed.length - 1;
      hash.update = (data: string) => {
        read += data.length;
        hashed[at] = read;
        return update(data);
      };
      return hash;
    },
  };
});

/**
 * The collector refuses a whole batch over one value longer than it accepts,
 * so every bounded field is cut before it is sent - the same way, whichever
 * field it is.
 */
describe("fitToLength", () => {
  it("keeps a value that fits as it is", () => {
    expect(fitToLength("orders.placed", 100)).toBe("orders.placed");
    expect(fitToLength("x".repeat(100), 100)).toBe("x".repeat(100));
  });

  it("cuts a longer one to exactly the limit, keeping its head", () => {
    const value = `orders.${"placed.".repeat(30)}`;

    const fitted = fitToLength(value, 100);

    expect(fitted).toHaveLength(100);
    expect(value.startsWith(fitted.slice(0, 91))).toBe(true);
    expect(fitted).toMatch(/~[0-9a-f]{8}$/);
  });

  it("keeps values that differ only past the cut apart", () => {
    const head = "a".repeat(120);

    // Cut to their heads alone, these would arrive as one metric, one span
    // name, one service.
    expect(fitToLength(`${head}-one`, 100)).not.toBe(
      fitToLength(`${head}-two`, 100),
    );
  });

  it("cuts the same value the same way every time", () => {
    const value = "b".repeat(300);

    expect(fitToLength(value, 255)).toBe(fitToLength(value, 255));
  });

  it("does not split a character made of two code units", () => {
    // An emoji is two UTF-16 code units; cut between them, the wire would
    // carry half of it.
    const value = `${"c".repeat(90)}🙂${"d".repeat(40)}`;

    const fitted = fitToLength(value, 100);

    expect(fitted.length).toBeLessThanOrEqual(100);
    expect(fitted).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  describe("a value far longer than the limit", () => {
    beforeEach(() => {
      hashed.length = 0;
    });

    // A span or metric named after a client string: each read of the whole
    // of it - the hash, the cache key - cost as much as the string was long,
    // and the cache kept a thousand of them whole.
    const long = (tag: string) => `${tag}:${"x".repeat(1_000_000)}`;

    it("reads a bounded head of it, not the whole", () => {
      const fitted = fitToLength(long("head"), 255);

      expect(fitted).toHaveLength(255);
      expect(fitted.startsWith("head:xxx")).toBe(true);
      expect(hashed).toHaveLength(1);
      expect(hashed[0]).toBeLessThanOrEqual(1_100);
    });

    it("is not remembered whole", () => {
      const value = long("again");

      expect(fitToLength(value, 255)).toBe(fitToLength(value, 255));
      // Cut afresh each time rather than kept as a key of the cache.
      expect(hashed).toHaveLength(2);
    });

    it("keeps values of different lengths with one head apart", () => {
      const head = "y".repeat(2_000);

      expect(fitToLength(`${head}-one`, 255)).not.toBe(
        fitToLength(`${head}-three`, 255),
      );
    });
  });
});
