type AnyFunction = (this: any, ...args: any[]) => any;

/**
 * Replaces `name` on whichever prototype in the chain actually defines it, and
 * parks the original beside it under a symbol.
 *
 * On the owner, because drivers build their public classes by inheritance
 * (mysql2's `PoolConnection -> Connection -> BaseConnection`): patching a
 * subclass would miss its siblings. Under a symbol, so a second agent in the
 * same process - a second Nest app, a test suite - replaces the wrapper
 * rather than wrapping it again.
 *
 * Returns `false` when no prototype in the chain defines the method.
 */
export function patchMethod(
  prototype: object | undefined | null,
  name: string,
  wrap: (original: AnyFunction) => AnyFunction,
): boolean {
  let owner: any = prototype;
  while (owner && !Object.hasOwn(owner, name)) {
    owner = Object.getPrototypeOf(owner);
  }
  if (!owner || owner === Object.prototype) {
    return false;
  }
  const key = Symbol.for(`nestjs.observe.original.${name}`);
  const original: unknown = owner[key] ?? owner[name];
  if (typeof original !== "function") {
    return false;
  }
  owner[key] = original;
  owner[name] = wrap(original as AnyFunction);
  return true;
}
