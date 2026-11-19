import { types } from "util";

/**
 * What a microservice context's accessor - `getMetadata()`, `getPattern()` -
 * answers, or `undefined` for a context without one.
 *
 * The accessor is found by name, since a custom transporter delivers a
 * context class of its own, and there it may be anything - asynchronous,
 * too. What it promises cannot be read here: the callers answer before it
 * settles, so it counts as no answer. But the promise is one this call made
 * and nothing else holds, so its rejection is handled here: unhandled, it
 * ended the process. The handler's own call makes a promise of its own,
 * which stays the application's to await.
 *
 * Kept out of `default-trace-id-generator.util.ts`, one of its callers:
 * everything that module exports is re-exported from the package root.
 */
export function readContextAccessor(
  context: unknown,
  name: "getMetadata" | "getPattern",
): unknown {
  const accessor = (
    context as Partial<Record<typeof name, unknown>> | null | undefined
  )?.[name];
  if (typeof accessor !== "function") {
    return undefined;
  }
  const value: unknown = accessor.call(context);
  if (types.isPromise(value)) {
    value.then(undefined, () => undefined);
    return undefined;
  }
  return value;
}
