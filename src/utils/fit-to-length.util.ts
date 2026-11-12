import { createHash } from "crypto";

/** How much of a cut value is a hash of the whole. */
const HASH_LENGTH = 8;

/**
 * Values already cut, so one that keeps arriving - a metric's name, encoded on
 * every increment - is hashed once. Cleared rather than evicted when full: it
 * only ever holds values longer than a limit, which are rare.
 */
const fitted = new Map<string, string>();
const MAX_REMEMBERED = 1_000;

/**
 * Longest value that is remembered, and most of a value that is hashed.
 *
 * A value is as long as whoever named the thing made it - a span or a metric
 * named after a client's string - and a whole read of it, by the hash or as a
 * key of the cache, cost as much as it was long, on every value; the cache
 * then held a thousand of them whole. Past this, the hash covers the head and
 * the length, so values that share a head stay apart unless they also share
 * a length.
 */
const MAX_READ_LENGTH = 1024;

/**
 * `value`, at most `maxLength` characters long, for a field the collector
 * bounds. The collector does not cut a longer value down: it refuses the whole
 * batch the value rides in, logs and spans included.
 *
 * Keeps the head, which is what a reader recognises, and ends in a hash of the
 * whole after a `~`, so two values that differ only past the cut stay apart.
 * Never splits a surrogate pair, which would send half a character.
 */
export function fitToLength(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const remembers = value.length <= MAX_READ_LENGTH;
  const key = remembers ? `${maxLength}:${value}` : undefined;
  const remembered = key === undefined ? undefined : fitted.get(key);
  if (remembered !== undefined) {
    return remembered;
  }

  let head = maxLength - HASH_LENGTH - 1;
  const last = value.charCodeAt(head - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head -= 1;
  }
  const hash = createHash("sha256");
  if (remembers) {
    hash.update(value);
  } else {
    hash.update(value.slice(0, MAX_READ_LENGTH)).update(`:${value.length}`);
  }
  // Its own copy: a slice keeps the whole of the value it was cut from alive
  // for as long as the cut is held - by the cache, by the batch.
  const cut = copyOf(
    `${value.slice(0, head)}~${hash.digest("hex").slice(0, HASH_LENGTH)}`,
  );

  if (key !== undefined) {
    if (fitted.size >= MAX_REMEMBERED) {
      fitted.clear();
    }
    fitted.set(key, cut);
  }
  return cut;
}

/** A flat string of its own, sharing nothing with what it was built from. */
function copyOf(text: string): string {
  return JSON.parse(JSON.stringify(text)) as string;
}
