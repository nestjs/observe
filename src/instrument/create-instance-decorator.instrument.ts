import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";

/**
 * Stand-in "class name" for instrumented standalone functions. Unlike methods,
 * they have no enclosing class to borrow a name from, so every span they emit
 * is grouped under this label.
 */
const STANDALONE_FUNCTION_LABEL = "Function";

type AnyFunction = (...args: any[]) => any;

interface TracedCallSpec {
  /**
   * Name of the class owning the instrumented method, or
   * `STANDALONE_FUNCTION_LABEL` for standalone functions.
   */
  className: string;
  methodName: string;
  spanId: string;

  /**
   * Re-entrancy guard. While a call is being traced, nested calls to the very
   * same callable run untraced so that recursion does not blow up the trace
   * tree.
   */
  isActive: () => boolean;
  setActive: (active: boolean) => void;

  /** Invokes the original callable, participating in the trace. */
  call: (thisArg: unknown, args: unknown[]) => unknown;

  /** Invokes the original callable, bypassing instrumentation entirely. */
  callUntraced: (thisArg: unknown, args: unknown[]) => unknown;
}

export function createInstanceDecorator<T extends Record<string, unknown>>(
  als: AsyncLocalStorage<Map<KeyOf<T>, any>>,
  operationTraceRegistry: OperationTraceRegistry,
  options: {
    /**
     * The trace ID key used to identify the trace in the context.
     * This key is used to store the trace ID in the context for later retrieval.
     */
    traceIdKey: string;

    /**
     * A function to determine whether to skip instrumentation for a given instance.
     * This function should return true if the instance should not be instrumented.
     */
    skipInstrumentation: (instance: unknown) => boolean;
  },
) {
  /**
   * Builds the tracing wrapper shared by methods and standalone functions.
   *
   * Every function this creates is named `<className>.<methodName>`, so the
   * frames instrumentation contributes to a stack trace read like the call the
   * user actually made instead of `Proxy.proxyFn`.
   */
  const createTracedWrapper = (spec: TracedCallSpec) => {
    const { className, methodName, spanId } = spec;
    const frameName = `${className}.${methodName}`;

    // Pulled out of `spec` so they are invoked as plain functions: calling them
    // as `spec.call(...)` would make `spec` the frame's receiver and print
    // "Object.<name>".
    const call = spec.call;
    const callUntraced = spec.callUntraced;

    // A function expression, not an arrow: the wrapper has to forward whatever
    // `this` the caller invoked it with. Nested arrows below inherit it.
    return named(frameName, function (this: unknown, ...args: unknown[]) {
      // Already tracing this callable, invoke it as-is
      if (spec.isActive()) {
        return callUntraced(this, args);
      }

      const store = als.getStore();
      const requestId = store?.get(options.traceIdKey);
      if (!requestId) {
        return callUntraced(this, args);
      }
      spec.setActive(true);

      const callerId = store?.get(CALLER_METADATA_KEY) as string | undefined;
      const newStepId = operationTraceRegistry.internalStartTraceStep(
        requestId,
        className,
        methodName,
        callerId,
      );

      // No step means the registry holds no snapshot for this trace id: the
      // request was dropped by `http.ignore` or sampled out, but its store
      // still carries the id - log correlation needs it there. Nothing was
      // opened, so nothing must be closed; without this bail-out every
      // provider call on an ignored route logged a registry error.
      if (newStepId === undefined) {
        try {
          return callUntraced(this, args);
        } finally {
          spec.setActive(false);
        }
      }

      const onReturnValue = (res: unknown) => {
        operationTraceRegistry.internalEndTraceStep(
          requestId,
          spanId,
          className,
          methodName,
          newStepId,
        );
        return res;
      };
      const onError = (err: any) => {
        // Before the registry records the step: `internalEndTraceStep` copies
        // `err.stack` into the span payload (and, on a root span, into the
        // snapshot that becomes the error group's sample), so relabelling
        // afterwards would leave that copy carrying this frame's `Proxy.`.
        relabelProxyFrame(err, className, methodName);
        operationTraceRegistry.internalEndTraceStep(
          requestId,
          spanId,
          className,
          methodName,
          newStepId,
          err,
        );
        // Re-throw the error to maintain original behavior
        throw err;
      };
      return als.run(
        new Map([
          ...(store?.entries() ?? []),
          [CALLER_METADATA_KEY, newStepId],
        ]),
        named(frameName, () => {
          try {
            const result = call(this, args);
            if (result instanceof Promise) {
              return result.then(onReturnValue).catch(onError);
            }
            return onReturnValue(result);
          } catch (err) {
            onError(err);
          } finally {
            spec.setActive(false);
          }
        }),
      );
    });
  };

  const instrumentFunction = (fn: AnyFunction) => {
    // Classes are functions too, but calling one is a construction, not the
    // kind of call this decorator traces.
    if (isClass(fn) || options.skipInstrumentation(fn)) {
      return fn;
    }

    const methodName = fn.name || "anonymous";
    const className = STANDALONE_FUNCTION_LABEL;
    const frameName = `${className}.${methodName}`;

    // A standalone function has no owner object to hang per-instance state off,
    // so the re-entrancy flag lives in this closure instead.
    let active = false;

    const invoke = named(frameName, (thisArg: unknown, args: unknown[]) =>
      Reflect.apply(fn, thisArg, args),
    );
    const tracedFn = createTracedWrapper({
      className,
      methodName,
      spanId: `${className}#${methodName}`,
      isActive: () => active,
      setActive: (value) => (active = value),
      call: invoke,
      callUntraced: invoke,
    });

    // Proxying the function (rather than handing back the wrapper itself) keeps
    // everything else about it intact for free: `name`, `length`, `prototype`,
    // static properties, `instanceof` and reflect-metadata lookups. Only
    // `apply` is trapped, so `new fn()` still constructs the original.
    return new Proxy(fn, {
      apply: named(frameName, (_target, thisArg, args) =>
        Reflect.apply(tracedFn, thisArg, args),
      ),
    });
  };

  const instrumentObject = (instance: object) => {
    if (options.skipInstrumentation(instance)) {
      return instance;
    }

    // Native private members (`this.#x`) are branded to the instance itself,
    // and no proxy trap can satisfy that check: a method invoked with the
    // proxy as its receiver throws "Receiver must be an instance of class".
    // Such classes get the raw instance as receiver instead - trading away
    // nested `this.other()` spans (those calls no longer pass through the
    // proxy) for methods that run at all.
    //
    // Built-ins backed by internal slots (`Map`, `Set`, `Date`, ...) hit the
    // same wall for the same reason: `Map.prototype.has` reads `[[MapData]]`
    // off its receiver, internal slots never forward through a proxy, so the
    // call throws "called on incompatible receiver" (nestjs/nest#17569).
    let hasPrivateMembers: boolean;
    let slotBacked: boolean;
    let bareBuiltIn: boolean;
    try {
      hasPrivateMembers = usesNativePrivateMembers(instance);
      slotBacked = isSlotBackedBuiltIn(instance);
      bareBuiltIn = slotBacked && isNativeFunction(instance.constructor);
    } catch {
      // Reading the prototype ran a trap that threw (nestjs-cls proxy
      // providers do this outside a CLS context). An instance that cannot be
      // inspected cannot be instrumented; hand it back untouched.
      return instance;
    }

    // A bare built-in registered as a provider (`useValue: new Map()`) has no
    // user code to trace - every method on it is native, and each one would
    // throw through the proxy. Hand it back untouched. A user *subclass* of a
    // built-in still carries methods worth tracing, so it falls through to the
    // raw-receiver path below instead.
    if (bareBuiltIn) {
      return instance;
    }

    // Slot-backed subclasses share the private-member trade-off: methods run
    // against the raw instance so the natives they inherit keep working.
    const requiresRawReceiver = hasPrivateMembers || slotBacked;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const methodRefsCache = new WeakMap<object, Function>();
    const currentlyTracing = new WeakMap<object, Set<string>>();
    return new Proxy(instance, {
      get: (target, prop, receiver) => {
        const attributeValue = Reflect.get(target, prop);
        const isFunction =
          typeof attributeValue === "function" && prop !== "constructor";

        const shouldProxy =
          isFunction &&
          !isClass(attributeValue) &&
          // A callable *object* - a Mongoose model, an Axios instance, an
          // EventEmitter-backed client - is a field, not a method. The traced
          // wrapper is a fresh bound function, so wrapping one silently drops
          // everything hanging off it (`svc.model.find` became undefined
          // mid-trace). This subsumes the Axios special case that used to sit
          // here: an Axios instance is a bound `request` carrying its API as
          // own properties.
          !isCallableObject(attributeValue);
        if (!shouldProxy) {
          return Reflect.get(target, prop);
        }

        const className = target.constructor.name;
        const methodName = String(prop);
        const frameName = `${className}.${methodName}`;

        // When "originalMethod" is already proxied, return the cached version
        if (methodRefsCache.has(attributeValue)) {
          return methodRefsCache.get(attributeValue);
        }

        // For a private-member class, `Reflect.get` with the proxy as receiver
        // would already throw on an accessor that touches `this.#x`, so the
        // value fetched against the target above is reused instead.
        const originalMethod = requiresRawReceiver
          ? attributeValue
          : Reflect.get(target, prop, receiver);
        const tracedReceiver = requiresRawReceiver ? target : receiver;
        const proxyFn = createTracedWrapper({
          className,
          methodName,
          spanId: generateSpanId(target, methodName),
          isActive: () =>
            currentlyTracing.get(target)?.has(methodName) ?? false,
          setActive: (active) => {
            if (!currentlyTracing.has(target)) {
              currentlyTracing.set(target, new Set());
            }
            const activeMethods = currentlyTracing.get(target)!;
            if (active) {
              activeMethods.add(methodName);
            } else {
              activeMethods.delete(methodName);
            }
          },
          // Traced calls run against the proxy so that a method calling into
          // itself (`this.other()`) is instrumented as a nested step - except
          // for private-member classes, whose brand checks only the raw
          // instance satisfies.
          call: named(frameName, (_thisArg, args) =>
            originalMethod.apply(tracedReceiver, args),
          ),
          callUntraced: named(frameName, (_thisArg, args) =>
            originalMethod.apply(target, args),
          ),
        });

        // V8 hard-codes the type name of a stack frame to "Proxy" whenever the
        // frame's receiver is a proxy, and no trap can override that. The
        // wrapper never reads `this`, so handing it out with the receiver
        // detached costs nothing and makes V8 treat its frame as top-level -
        // printing the "<Class>.<method>" name above on its own.
        const boundFn = proxyFn.bind(undefined);

        // `bind` renames the function to "bound <name>" and drops metadata;
        // restore both so the wrapper stays indistinguishable from the original
        // to anything reflecting over it (DI, decorators, arity checks).
        Object.defineProperty(boundFn, "name", {
          value: originalMethod.name,
          configurable: true,
        });
        Object.defineProperty(boundFn, "length", {
          value: originalMethod.length,
          configurable: true,
        });
        const metadataKeys = Reflect.getMetadataKeys(originalMethod);
        for (const key of metadataKeys) {
          const metadata = Reflect.getMetadata(key, originalMethod);
          Reflect.defineMetadata(key, metadata, boundFn);
        }

        methodRefsCache.set(attributeValue, boundFn);
        return boundFn;
      },
    });
  };

  return (instance: unknown) => {
    if (typeof instance === "function") {
      return instrumentFunction(instance as AnyFunction);
    }
    if (typeof instance === "object" && instance) {
      return instrumentObject(instance);
    }
    return instance;
  };
}

/**
 * Renames a function so that V8 prints `name` for the stack frames it appears
 * in. The `name` property is what the stack serializer reads, so redefining it
 * is enough - the function keeps its identity and behavior.
 */
function named<T extends AnyFunction>(name: string, fn: T): T {
  Object.defineProperty(fn, "name", { value: name, configurable: true });
  return fn;
}

/**
 * Rewrites the `Proxy.<method>` frame an instrumented call leaves behind into
 * `<Class>.<method>`.
 *
 * V8 stamps "Proxy" as the type name of any frame whose receiver is a proxy and
 * no trap can override that. Traced calls run against the proxy on purpose (so
 * `this.other()` is picked up as a nested step), which means the *original*
 * method's own frame is the one that prints as `Proxy.<method>` - the wrapper
 * frames around it are already named after the class.
 *
 * Only the topmost match is rewritten. Every wrapper on the way out relabels
 * its own frame, and inner calls unwind before outer ones, so two classes that
 * happen to share a method name each end up with the right label.
 */
function relabelProxyFrame(
  err: unknown,
  className: string,
  methodName: string,
): void {
  if (!(err instanceof Error) || typeof err.stack !== "string") {
    return;
  }
  // `async` prefixes the type name on frames resumed from an await.
  const frame = new RegExp(
    `(\\n\\s*at (?:async )?)Proxy\\.${escapeRegExp(methodName)}\\b`,
  );
  if (!frame.test(err.stack)) {
    return;
  }
  try {
    err.stack = err.stack.replace(frame, `$1${className}.${methodName}`);
  } catch {
    // Some errors ship a read-only `stack`; the label is cosmetic, so leaving
    // it as-is beats masking the original failure.
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isClass(value: AnyFunction): boolean {
  return /^\s*class\s+/.test(value.toString());
}

/**
 * The prototypes every ordinary function - plain, async, generator, async
 * generator, arrow, bound - hangs off. Anything else above a callable means it
 * was built by a library as an object that happens to be invocable.
 */
const INTRINSIC_FUNCTION_PROTOTYPES = new Set<object | null>([
  Function.prototype,
  Object.getPrototypeOf(async function () {}),
  Object.getPrototypeOf(function* () {}),
  Object.getPrototypeOf(async function* () {}),
]);

/**
 * Whether a function is really an object with a call signature - a Mongoose
 * model with its statics, a client with methods hung directly on it - rather
 * than a method to be traced.
 *
 * Two tells, either sufficient: a prototype that is not one of the intrinsic
 * function prototypes (Mongoose sets `M.__proto__ = Model`), or own enumerable
 * properties, which a plain method never carries but statics are. The traced
 * wrapper is a fresh function that preserves only `name` and reflect-metadata,
 * so anything matching here must be handed out untouched.
 */
function isCallableObject(fn: AnyFunction): boolean {
  return (
    !INTRINSIC_FUNCTION_PROTOTYPES.has(Object.getPrototypeOf(fn)) ||
    Object.keys(fn).length > 0
  );
}

/**
 * Prototypes of the built-ins whose methods read internal slots
 * (`[[MapData]]`, `[[SetData]]`, `[[DateValue]]`, ...) off their receiver.
 * Internal slots live on the target and never forward through a proxy, so any
 * such method invoked with the instrumentation proxy as receiver throws
 * "called on incompatible receiver".
 *
 * `%TypedArray%.prototype` (reached via `Uint8Array`'s parent) covers every
 * typed array - and, through it, Node's `Buffer`. `Array` is deliberately
 * absent: its methods are generic and proxy-safe.
 */
const SLOT_BACKED_PROTOTYPES = new Set<object>([
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  WeakSet.prototype,
  Date.prototype,
  RegExp.prototype,
  Promise.prototype,
  ArrayBuffer.prototype,
  ...(typeof SharedArrayBuffer === "undefined"
    ? []
    : [SharedArrayBuffer.prototype]),
  DataView.prototype,
  WeakRef.prototype,
  FinalizationRegistry.prototype,
  Object.getPrototypeOf(Uint8Array.prototype) as object,
]);

/**
 * Whether the instance's prototype chain passes through a slot-backed
 * built-in, meaning its (inherited) native methods would throw if invoked with
 * a proxy as their receiver.
 */
function isSlotBackedBuiltIn(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto) {
    if (SLOT_BACKED_PROTOTYPES.has(proto)) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Whether a constructor is engine- or platform-provided rather than user
 * code. A slot-backed instance whose entire chain is native (`new Map()`,
 * `Buffer.from(...)`) carries nothing to trace; one with a user constructor on
 * top (`class Cache extends Map`) does.
 */
function isNativeFunction(fn: unknown): boolean {
  if (typeof fn !== "function") {
    // No constructor at all (`Object.create(Map.prototype)`): nothing
    // user-defined to trace either.
    return true;
  }
  try {
    return /\{\s*\[native code\]\s*\}$/.test(
      Function.prototype.toString.call(fn),
    );
  } catch {
    return true;
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
const privateMemberCache = new WeakMap<Function, boolean>();

/**
 * Whether any class in the instance's prototype chain declares native private
 * members (`#field`, `#method()`).
 *
 * Detection reads the class source: private members can only be touched from
 * inside the lexical class body, so a class whose text contains no `#name`
 * token cannot perform a brand check. A `#` inside a string or comment can
 * false-positive, which merely selects the raw-instance receiver - every call
 * still works, only nested self-call spans are lost - so the cheap test is
 * safe to lean on.
 */
function usesNativePrivateMembers(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    const ctor = proto.constructor;
    if (typeof ctor === "function" && ctor !== Object) {
      let hasPrivate = privateMemberCache.get(ctor);
      if (hasPrivate === undefined) {
        hasPrivate = declaresPrivateMembers(ctor);
        privateMemberCache.set(ctor, hasPrivate);
      }
      if (hasPrivate) {
        return true;
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function declaresPrivateMembers(ctor: Function): boolean {
  try {
    // `#` starting a private name is never preceded by an identifier
    // character; `obj.#x` and `#x in obj` and declarations all match.
    return /(^|[^\w$])#[\w$]/.test(Function.prototype.toString.call(ctor));
  } catch {
    // A constructor whose source is unavailable (bound functions, some
    // natives) cannot be a class body with private members.
    return false;
  }
}

function generateSpanId(instance: object, methodKey: string): string {
  return `${instance.constructor.name}#${methodKey}`;
}
