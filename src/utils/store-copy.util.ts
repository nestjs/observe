/**
 * A span runs in a copy of its caller's store, so that the copy can name the
 * span as the caller of whatever it calls. An attribute written to the copy
 * alone was gone once the span returned - one a guard, a pipe or a service
 * set never reached the handler - while an operation that is not recorded
 * makes no copies and kept it.
 *
 * So each copy remembers the store it was made from, here rather than in the
 * store: the store is the application's to read and write as well, and an
 * entry of the agent's own would show in every `entries()` it walks. An
 * attribute is written through the copy to every store it came from, so it
 * is there once the span returns, for `getAttribute` and for a plain
 * `store.get` alike.
 */
const copiedFrom = new WeakMap<Map<unknown, unknown>, Map<unknown, unknown>>();

/** A copy of `store` for a span, with `entries` over what it copies. */
export function copyStore<K, V>(
  store: Map<K, V>,
  ...entries: Array<[K, V]>
): Map<K, V> {
  const copy = new Map(store);
  for (const [key, value] of entries) {
    copy.set(key, value);
  }
  copiedFrom.set(copy, store);
  return copy;
}

/** Sets `key` in `store` and in every store it was copied from. */
export function setThroughCopies(
  store: Map<any, unknown>,
  key: unknown,
  value: unknown,
): void {
  for (
    let current: Map<unknown, unknown> | undefined = store;
    current;
    current = copiedFrom.get(current)
  ) {
    current.set(key, value);
  }
}

/**
 * `key` as `store` holds it, or else as the nearest store it was copied from
 * holds it: what a span running beside the one that set it - copied before
 * it was set - still finds in the operation's own store.
 */
export function getThroughCopies(
  store: Map<any, unknown>,
  key: unknown,
): unknown {
  for (
    let current: Map<unknown, unknown> | undefined = store;
    current;
    current = copiedFrom.get(current)
  ) {
    if (current.has(key)) {
      return current.get(key);
    }
  }
  return undefined;
}
