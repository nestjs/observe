/**
 * Where an operation's store keeps what `TracerService.setAttribute` wrote:
 * one map for the whole operation.
 *
 * A span runs in a copy of its caller's store, so that the copy can name the
 * span as the caller of whatever it calls. An attribute written to the copy
 * alone was gone once the span returned - one a guard, a pipe or a service
 * set never reached the handler - while an operation that is not recorded
 * makes no copies and kept it. Every copy holds this same map instead, so an
 * attribute outlives the span it was set in either way.
 *
 * A symbol, so that no attribute, and no key a client sends, can name it.
 */
export const SHARED_ATTRIBUTES_KEY = Symbol("nestjs.observe.attributes");

/**
 * The operation's attribute map, made on first use. A store has to hold it
 * before it is copied for a span, or the copy and its caller each made one of
 * their own.
 */
export function sharedAttributesOf(
  store: Map<any, unknown>,
): Map<unknown, unknown> {
  let attributes = store.get(SHARED_ATTRIBUTES_KEY) as
    | Map<unknown, unknown>
    | undefined;
  if (!attributes) {
    attributes = new Map();
    store.set(SHARED_ATTRIBUTES_KEY, attributes);
  }
  return attributes;
}
