import { AsyncResource } from "node:async_hooks";
import { patchMethod } from "./patch-method.util.js";

/**
 * The async context each request was first dispatched in, by its handler.
 *
 * undici creates a request - and publishes `undici:request:create`, which the
 * HTTP integration reads the caller from - in whatever context the dispatch
 * that gets it to a client runs in. The first pass through `dispatch` is the
 * caller's own call. A later one may run from a socket's events, in the
 * context of whichever request opened that socket: a bounded pool handing a
 * queued request to a client as another one drains, a redirect or a retry
 * re-dispatched from a response. Each later pass is run where the first was.
 *
 * Keyed by handler: undici's own `request`, `stream`, `pipeline` and `fetch`
 * make one per request. An application that calls `dispatch()` itself with
 * one handler for several requests gets them all filed under the first.
 */
const callers = new WeakMap<object, AsyncResource>();

type Dispatch = (this: unknown, opts: unknown, handler: unknown) => unknown;

/**
 * `Dispatcher#dispatch` on undici's base class, which `Agent`, `Pool`,
 * `Client` and the rest share, and which every layer passes a request
 * through.
 */
export function patchUndiciDispatch(module: unknown): boolean {
  const base = defaultExport(module) as { prototype?: object } | undefined;
  return patchMethod(
    base?.prototype,
    "dispatch",
    (original) =>
      function (this: unknown, ...args: Parameters<Dispatch>) {
        const handler = args[1];
        if (typeof handler !== "object" || handler === null) {
          return original.apply(this, args);
        }
        const caller = callers.get(handler);
        if (caller) {
          return caller.runInAsyncScope(original, this, ...args);
        }
        callers.set(handler, new AsyncResource("ObserveUndiciDispatch"));
        return original.apply(this, args);
      },
  );
}

/**
 * `UnwrapHandler.unwrap` on undici 7, which hands each layer below a new
 * wrapper of the handler on every pass: the wrapper is filed under its
 * handler's caller, so a later pass is recognised below a dispatcher
 * composed - its `dispatch` bound - before the base class was patched.
 */
export function patchUndiciUnwrap(module: unknown): boolean {
  const unwrapHandler = defaultExport(module) as object | undefined;
  return patchMethod(
    unwrapHandler,
    "unwrap",
    (original) =>
      function (this: unknown, handler: unknown) {
        const wrapped: unknown = original.call(this, handler);
        if (
          wrapped !== handler &&
          typeof wrapped === "object" &&
          wrapped !== null &&
          typeof handler === "object" &&
          handler !== null
        ) {
          let caller = callers.get(handler);
          if (!caller) {
            caller = new AsyncResource("ObserveUndiciDispatch");
            callers.set(handler, caller);
          }
          callers.set(wrapped, caller);
        }
        return wrapped;
      },
  );
}

function defaultExport(module: unknown): unknown {
  return typeof module === "function"
    ? module
    : (module as { default?: unknown } | undefined)?.default;
}
