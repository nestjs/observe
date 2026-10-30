import { randomFillSync } from "crypto";

/** Random bytes in each id: 12 bits go into `rand_a`, 62 into `rand_b`. */
const RANDOM_BYTES_PER_ID = 10;

/**
 * Random bytes for the ids below, refilled 1,024 ids' worth at a time.
 *
 * The agent mints an id for every span, so this runs once per provider call
 * of every traced request. A `randomBytes(10)` per id - a native call and a
 * buffer each time - was the agent's largest single cost on the request path:
 * a fifth of the main thread's busy time on an endpoint with nine spans. The
 * bytes still come from the CSPRNG; it is asked once per 1,024 ids, the way
 * `crypto.randomUUID()` caches its own entropy.
 */
const pool = Buffer.allocUnsafe(RANDOM_BYTES_PER_ID * 1024);
let poolOffset = pool.length;

const HEX_DIGITS = "0123456789abcdef";

/** Each byte value's two hex digits, as character codes. */
const HIGH_DIGIT = Uint8Array.from({ length: 256 }, (_, byte) =>
  HEX_DIGITS.charCodeAt(byte >>> 4),
);
const LOW_DIGIT = Uint8Array.from({ length: 256 }, (_, byte) =>
  HEX_DIGITS.charCodeAt(byte & 0x0f),
);

/**
 * The id's 36 characters, written in place and read out as one string; the
 * hyphens never move. Joined from pieces instead, an id was a concatenation
 * V8 had to flatten before it could hash it, and the registry hashes every
 * span id - as a map key - the moment it is minted.
 */
const text = Buffer.alloc(36, "-");

function writeByte(at: number, byte: number): void {
  text[at] = HIGH_DIGIT[byte];
  text[at + 1] = LOW_DIGIT[byte];
}

/**
 * A UUID whose first 48 bits are the minting time, milliseconds since the
 * epoch (RFC 9562 version 7).
 *
 * Every id the agent mints itself - a trace id when no request id arrived, a
 * span id, a scheduled run's id - is stored by the collector in time-ordered
 * hypertables and later looked up by that id alone. A random id says nothing
 * about when, so a lookup by it has to consider every chunk the project
 * keeps; a v7 id tells the collector which chunk to open. Ids the agent did
 * not mint - a propagated `x-request-id`, a customer's own trace key - are
 * passed through untouched, and the collector treats those as before.
 *
 * Same layout as the collector's own generator, so ids from either side
 * decode the same way.
 */
export function uuidv7(now: number = Date.now()): string {
  if (poolOffset + RANDOM_BYTES_PER_ID > pool.length) {
    randomFillSync(pool);
    poolOffset = 0;
  }
  const r = poolOffset;
  poolOffset += RANDOM_BYTES_PER_ID;

  // 48-bit big-endian timestamp, split 32/16 so no shift runs past 2^32.
  const high = Math.floor(now / 0x10000);
  const low = now % 0x10000;
  writeByte(0, (high >>> 24) & 0xff);
  writeByte(2, (high >>> 16) & 0xff);
  writeByte(4, (high >>> 8) & 0xff);
  writeByte(6, high & 0xff);
  writeByte(9, (low >>> 8) & 0xff);
  writeByte(11, low & 0xff);
  // Version 7 in the top nibble, 12 random bits below it.
  writeByte(14, 0x70 | (pool[r] & 0x0f));
  writeByte(16, pool[r + 1]);
  // Variant `10` in the top two bits, 62 random bits below.
  writeByte(19, 0x80 | (pool[r + 2] & 0x3f));
  writeByte(21, pool[r + 3]);
  for (let i = 0; i < 6; i++) {
    writeByte(24 + i * 2, pool[r + 4 + i]);
  }
  return text.toString("latin1");
}
