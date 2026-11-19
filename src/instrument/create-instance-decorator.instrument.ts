import { Reflector } from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { X509Certificate } from "node:crypto";
import { Stream } from "node:stream";
import { types } from "node:util";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { KeyOf } from "../types/key-of.type.js";
import {
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { sharedAttributesOf } from "../utils/shared-attributes.util.js";
import { registerRawReceiver } from "./raw-receiver.js";

/**
 * Stand-in "class name" for instrumented standalone functions. Unlike methods,
 * they have no enclosing class to borrow a name from, so every span they emit
 * is grouped under this label.
 */
const STANDALONE_FUNCTION_LABEL = "Function";

/** Class name for an instance that has no constructor function. */
const FALLBACK_CLASS_NAME = "Object";

type AnyFunction = (...args: any[]) => any;

/**
 * Whether an instance is a framework provider that is never instrumented,
 * whatever `skipInstrumentation` says.
 *
 * Nest's `Reflector` is the one: guards, interceptors and pipes ask it whether
 * a route is public, throttled or role-gated several times a request, each
 * answer a hundredth of a millisecond, and a waterfall full of those answers
 * explains nothing - while every one of them is a billed span. On one app it
 * was 18 spans in every request, 29% of all it sent. The collector drops what
 * older agents still send; this stops them being made.
 *
 * Matched by shape as well as by class: an application with a second copy of
 * `@nestjs/core` in its tree has a second `Reflector` class, which the
 * `instanceof` alone would miss.
 *
 * A `MongoClient` or `Db` registered as a provider is the other.
 */
function isFrameworkNoise(instance: object): boolean {
  if (instance instanceof Reflector) {
    return true;
  }
  const candidate = instance as {
    constructor?: { name?: unknown };
    getAllAndOverride?: unknown;
  };
  return (
    (candidate.constructor?.name === "Reflector" &&
      typeof candidate.getAllAndOverride === "function") ||
    isMongoDriverHandle(instance)
  );
}

/**
 * Whether an instance is the `mongodb` driver's `MongoClient` or `Db`.
 *
 * Instrumenting them breaks the driver, not just the waterfall. Traced calls
 * run with the proxy as receiver and untraced ones with the raw instance, so
 * what a method keeps of `this` depends on whether a trace was active: a `Db`
 * made at bootstrap holds the raw client, a session started in a traced
 * request holds the proxy, and the driver's `session.client !== client` check
 * throws "ClientSession must be from the same MongoClient" - for every
 * explicit session, transaction and `withSession` on a traced request, while
 * the same calls on a sampled-out one succeed. The command spans the mongodb
 * integration records are the useful part anyway; `Db.collection` and
 * `MongoClient.startSession` spans are not.
 *
 * Matched by name and shape only: the driver is an optional peer, never
 * imported here, and an application may carry more than one copy of it. The
 * name is looked for on every class up the prototype chain, so a provider
 * class that extends either one - `class MongoService extends MongoClient` -
 * is left alone too, for the same reason.
 */
function isMongoDriverHandle(instance: object): boolean {
  const candidate = instance as {
    startSession?: unknown;
    db?: unknown;
    collection?: unknown;
    databaseName?: unknown;
  };
  for (
    let proto = Object.getPrototypeOf(instance) as {
      constructor?: { name?: unknown };
    } | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as typeof proto
  ) {
    const name = Object.hasOwn(proto, "constructor")
      ? proto.constructor?.name
      : undefined;
    if (
      name === "MongoClient" &&
      typeof candidate.startSession === "function" &&
      typeof candidate.db === "function"
    ) {
      return true;
    }
    if (
      name === "Db" &&
      typeof candidate.collection === "function" &&
      typeof candidate.databaseName === "string"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an instance is data and nothing else: an object literal, a
 * null-prototype record or an array with no function and no accessor among
 * its own members - the options object or list behind a `useValue`, or what a
 * `useFactory` returns.
 *
 * It has no method of its own to trace, and a proxy around it breaks what the
 * value itself supports: the structured clone algorithm consults no trap and
 * refuses a proxy whatever its target is, so `structuredClone`, `postMessage`,
 * `workerData` and `v8.serialize` all threw on an injected options object.
 * What it inherits from `Object` or `Array` (`columns.map`) is no longer
 * traced either.
 *
 * Members are read as descriptors, so no getter runs here; an accessor may
 * hand out a function, and so counts as one. A proxy is never data: it
 * answers these questions with its traps - a nestjs-cls proxy provider reads
 * as `{}` until a request resolves it - and could not be cloned to begin with.
 */
function isPlainData(instance: object): boolean {
  if (types.isProxy(instance)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(instance);
  if (
    proto !== null &&
    proto !== Object.prototype &&
    proto !== Array.prototype
  ) {
    return false;
  }
  for (const key of Reflect.ownKeys(instance)) {
    const own = Reflect.getOwnPropertyDescriptor(instance, key);
    if (
      own === undefined ||
      own.get !== undefined ||
      own.set !== undefined ||
      typeof own.value === "function"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether an instance is a key or a certificate of `node:crypto`: a
 * `KeyObject`, a Web Crypto `CryptoKey` or an `X509Certificate`.
 *
 * Node recognises each by a brand of its own (`#slots in key`, an internal
 * slot) wherever one is handed in as an argument - to `createHmac`, `sign`,
 * `subtle.sign`, `cert.checkIssued`, and through them `jsonwebtoken` - and no
 * proxy carries it, so an injected key failed every call it was given to
 * ("The "key" argument must be of type ... KeyObject"). Its methods run
 * against the raw instance either way; handed out as a proxy, it is no longer
 * the object Node made.
 */
function isCryptoHandle(instance: object): boolean {
  return (
    types.isKeyObject(instance) ||
    types.isCryptoKey(instance) ||
    instance instanceof X509Certificate
  );
}

/**
 * Library classes traced only in part, each with a method only it has, which
 * tells it from an application's own class of the same name - `ValidationPipe`
 * is what Nest's documentation calls the pipe it has readers write themselves,
 * and plenty of applications have a `ConfigService` of their own.
 *
 * - Nest's validating pipes keep only `validate`. `ValidationPipe` runs once
 *   per handler argument, and for each one `transform`, `toValidate` and
 *   `transformPrimitive` were spans, usually of a few microseconds and each
 *   one billed, on runs that mostly validate nothing: 82% of runs across the
 *   hosted platform on 2026-11-06, which made it the busiest class after
 *   `pg`, and 404,552 of 404,652 on one REST app.
 * - `@nestjs/config`'s `ConfigService` keeps what an application calls. Each
 *   `get` made four or five more spans of its private helpers - 2.7M of its
 *   4.6M a day, in 220 projects.
 *
 * Folding cannot reach any of them (`collapseRepeatedSpans`), because each
 * repeats only a few times under its parent.
 *
 * By name, because `StandardSchemaValidationPipe` is not in every supported
 * `@nestjs/common` and an application may carry a second copy of a package.
 * A class that stops matching is simply traced like any other.
 */
const PARTLY_TRACED_CLASSES = new Map<
  string,
  { marker: string; traced: ReadonlySet<string> }
>([
  [
    "ValidationPipe",
    { marker: "flattenValidationErrors", traced: new Set(["validate"]) },
  ],
  [
    "StandardSchemaValidationPipe",
    { marker: "formatIssueMessages", traced: new Set(["validate"]) },
  ],
  [
    "ParseFilePipe",
    { marker: "validateFilesOrFile", traced: new Set(["validate"]) },
  ],
  [
    "ConfigService",
    {
      marker: "getFromValidatedEnv",
      traced: new Set(["get", "getOrThrow", "set", "setEnvFilePaths"]),
    },
  ],
]);

/**
 * The methods a prototype's class keeps traced, if it is one of those.
 *
 * The marker has to be the class's own, and new with it. A subclass an
 * application names after the class it extends (`import { ValidationPipe as
 * NestValidationPipe }`) inherits the marker, or overrides it, and is still
 * the application's: taken for the library's, its methods were handed out
 * unwrapped, and one that reads a private member (`this.#x`) threw on the
 * proxy it then ran against.
 */
function partlyTracedMethodsOf(proto: object): ReadonlySet<string> | null {
  const candidate = proto as Record<string, unknown>;
  const entry = PARTLY_TRACED_CLASSES.get(
    (candidate.constructor as { name?: string } | undefined)?.name ?? "",
  );
  if (
    entry === undefined ||
    !Object.hasOwn(proto, entry.marker) ||
    typeof candidate[entry.marker] !== "function"
  ) {
    return null;
  }
  const parent: object | null = Object.getPrototypeOf(proto);
  return parent === null || !(entry.marker in parent) ? entry.traced : null;
}

/** Whether an instance is one of those classes, or extends one. */
function extendsPartlyTracedClass(instance: object): boolean {
  for (
    let proto = Object.getPrototypeOf(instance);
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (partlyTracedMethodsOf(proto) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a method is one of those classes' internals, and so makes no span.
 *
 * Asked of the class that holds the method, so what an application adds to or
 * overrides in a subclass is still traced. An instance's own function - the
 * `exceptionFactory` a constructor assigns - goes by the instance's class.
 */
function isLibraryInternal(
  target: object,
  methodName: string | symbol,
): boolean {
  let holder: object | null = target;
  while (holder !== null && !Object.hasOwn(holder, methodName)) {
    holder = Object.getPrototypeOf(holder);
  }
  if (holder === null) {
    return false;
  }
  const traced = partlyTracedMethodsOf(
    holder === target ? Object.getPrototypeOf(target) : holder,
  );
  return (
    traced !== null &&
    !(typeof methodName === "string" && traced.has(methodName))
  );
}

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

  /**
   * Whether the original callable is a native `async` function - the one
   * kind whose promise nothing but the caller can hold. See `callTraced`.
   */
  isAsync: boolean;

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
   * Builds the tracing wrapper shared by methods and standalone functions:
   * called with the receiver and the arguments of the call it stands in for,
   * as the `apply` trap that dispatches to it is handed them.
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
    const isAsync = spec.isAsync;

    const endStep = (requestId: string, stepId: string) =>
      operationTraceRegistry.internalEndTraceStep(
        requestId,
        spanId,
        className,
        methodName,
        stepId,
      );
    const recordError = (requestId: string, stepId: string, err: any) => {
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
        stepId,
        err,
      );
    };

    // Runs the call inside the span's own async context. Made once per
    // wrapper rather than once per call: `als.run` hands it the receiver, the
    // arguments and the span's ids, so a traced call allocates no closure for
    // it - and does not rename one, which cost as much again.
    const callTraced = named(
      frameName,
      (
        thisArg: unknown,
        args: unknown[],
        requestId: string,
        stepId: string,
      ) => {
        try {
          const result = call(thisArg, args);
          // Only a promise with the native `then` is chained or watched. A
          // `then` the promise brought itself is the caller's to call: on a
          // lazy promise (`p-lazy`, a postgres.js query) that call is what
          // starts the work, and the caller may never make it. Such a
          // promise is handed back like any other thenable, and its span
          // ends with the call.
          if (result instanceof Promise && hasNativeThen(result)) {
            // Closing the span is a side effect: a registry failure must
            // leave the caller with the value or rejection it would have
            // seen without the span.
            const settled = (value: unknown) => {
              ignoreFailure(() => endStep(requestId, stepId));
              return value;
            };
            const failed = (err: unknown) => {
              ignoreFailure(() => recordError(requestId, stepId, err));
              throw err;
            };
            // The promise of a native `async` method is swapped for a chained
            // one, just as the caller's own `.then` would: nothing but the
            // caller can hold it, so a rejection the caller drops still
            // raises `unhandledRejection`, as without the span.
            if (isAsync) {
              return result.then(settled, failed);
            }
            // Any other promise is handed back as-is and watched on a side
            // branch, the way `OutgoingSpanRecorder.endWhenSettled` watches
            // outgoing calls. It may be held elsewhere - a `.catch` the method
            // attached itself, an in-flight promise callers share, the
            // callback ioredis answers a command through - and a chained copy
            // rejected where those handlers do not reach: dropped by the
            // caller, it was an unhandled rejection, and under Node's default
            // it ended a process that handled the failure. Handed back, it
            // also keeps what it carries beyond its value (`kill()` on an
            // `execa` child, a subclass that keeps the native `then`).
            // Watching marks it handled, so a rejection nobody handles no
            // longer raises `unhandledRejection`; the span still records it.
            result.then(settled, (err) =>
              ignoreFailure(() => recordError(requestId, stepId, err)),
            );
            return result;
          }
          endStep(requestId, stepId);
          return result;
        } catch (err) {
          recordError(requestId, stepId, err);
          // Re-throw the error to maintain original behavior
          throw err;
        }
      },
    );

    // The receiver the call was made with is handed on, not read off `this`:
    // the wrapper is called as a plain function, so V8 prints its frame as
    // top-level, under the name above.
    return named(frameName, (thisArg: unknown, args: unknown[]) => {
      // Already tracing this callable, invoke it as-is
      if (spec.isActive()) {
        return callUntraced(thisArg, args);
      }

      const store = als.getStore();
      const requestId =
        store?.get(TRACE_REGISTRY_KEY) ?? store?.get(options.traceIdKey);
      if (!requestId) {
        return callUntraced(thisArg, args);
      }
      // Cleared in the frame that set it, whatever throws in between: opening
      // the step, copying the store and entering it can each run out of
      // stack, and a flag left set sent every later call of this method, from
      // any request, down the untraced path until the process restarted.
      spec.setActive(true);
      try {
        const callerId = store?.get(CALLER_METADATA_KEY) as string | undefined;
        const newStepId = operationTraceRegistry.internalStartTraceStep(
          requestId,
          className,
          methodName,
          callerId,
        );

        // No step means the registry holds no snapshot for this trace id -
        // the request was dropped by `http.ignore` or sampled out, but its
        // store still carries the id, which log correlation needs there - or
        // the operation has opened as many spans as one may. Nothing was
        // opened, so nothing must be closed; without this bail-out every
        // provider call on an ignored route logged a registry error.
        if (newStepId === undefined) {
          return callUntraced(thisArg, args);
        }

        // Everything the caller's context holds, with this span as the caller
        // of whatever it calls. A copy, so the caller's context still names
        // the caller once this call returns. Only the caller is the span's
        // own: the attribute map is made before the copy, so both hold the
        // same one, and an attribute set in the call is there after it.
        sharedAttributesOf(store!);
        const spanStore = new Map(store);
        spanStore.set(CALLER_METADATA_KEY, newStepId);
        return als.run(
          spanStore,
          callTraced,
          thisArg,
          args,
          requestId,
          newStepId,
        );
      } finally {
        spec.setActive(false);
      }
    });
  };

  const instrumentFunction = (fn: AnyFunction) => {
    // Classes are functions too, but calling one is a construction, not the
    // kind of call this decorator traces.
    if (isConstructor(fn) || options.skipInstrumentation(fn)) {
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
      isAsync: types.isAsyncFunction(fn),
      call: invoke,
      callUntraced: invoke,
    });

    // Proxying the function (rather than handing back the wrapper itself) keeps
    // everything else about it intact for free: `name`, `length`, `prototype`,
    // static properties, `instanceof` and reflect-metadata lookups. Only
    // `apply` is trapped, so `new fn()` still constructs the original.
    return new Proxy(fn, {
      apply: named(frameName, (_target, thisArg, args) =>
        tracedFn(thisArg, args),
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
    let partlyTraced: boolean;
    let nodeStream: boolean;
    try {
      // Inspected here, inside the guard, for the same reason as the checks
      // below: reading a provider's constructor can run a trap that throws.
      //
      // A frozen object is handed back as it is: a proxy has to answer a read
      // of each of its members with the member itself, so there is nothing
      // it could trace - see `isReadOnlyOwnValue`. So is plain data, which
      // has nothing to trace and which a proxy keeps from being cloned, and
      // a key or certificate of Node's own.
      if (
        isFrameworkNoise(instance) ||
        Object.isFrozen(instance) ||
        isPlainData(instance) ||
        isCryptoHandle(instance)
      ) {
        return instance;
      }
      hasPrivateMembers = usesPrivateMembers(instance);
      slotBacked = isSlotBackedBuiltIn(instance);
      bareBuiltIn = slotBacked && isNativeFunction(instance.constructor);
      partlyTraced = extendsPartlyTracedClass(instance);
      nodeStream = isNodeStream(instance);
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
    //
    // So does a Node stream, for what it is fed by. The HTTP parser, zlib, a
    // socket's handle or the generator behind `Readable.from` holds the raw
    // stream and emits on it, and Node tells a stream's listeners apart by
    // identity: the async iterator's "readable" listener compares its `this`
    // with the stream the iterator was made on. Made on the proxy by a traced
    // call, it never woke up, so `for await` over an injected request body
    // hung - and threw "callback is not a function" outside any request,
    // ending the process, once the client closed its socket.
    const requiresRawReceiver = hasPrivateMembers || slotBacked || nodeStream;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const methodRefsCache = new WeakMap<object, Function>();
    // Functions read off the instance that are handed out as they are:
    // constructors and callable objects.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    const passedThrough = new WeakSet<Function>();
    const proxy: object = new Proxy(instance, {
      // Runs for every property read through the proxy - each `this.field`
      // and `this.dependency.method` inside a traced call - so the common
      // answers come first: a read by something other than the proxy, a value
      // that is no method, then a method already wrapped.
      get: (target, prop, receiver) => {
        // An object that inherits from the proxy - what a traced method
        // derives from `this` with `Object.create(this)`, as pino's
        // `logger.child()` does - reads its property as it would without the
        // proxy, accessors against itself, and calls its methods with itself
        // as `this`. Wrapped and cached, the first such object to read a
        // method was the `this` of every later call of it, from any request.
        if (receiver !== proxy) {
          return Reflect.get(target, prop, receiver);
        }
        const attributeValue = Reflect.get(target, prop);
        if (typeof attributeValue !== "function" || prop === "constructor") {
          return attributeValue;
        }

        // A member the instance can never change is handed out as it is and
        // runs untraced: the engine accepts no other answer. Asked ahead of
        // both caches, which go by the function: the same one may also sit
        // under a writable key, and an instance can be frozen after its
        // method was wrapped.
        if (isReadOnlyOwnValue(target, prop)) {
          return attributeValue;
        }

        // When "originalMethod" is already proxied, return the cached version
        const cached = methodRefsCache.get(attributeValue);
        if (cached) {
          return cached;
        }
        if (passedThrough.has(attributeValue)) {
          return attributeValue;
        }

        const shouldProxy =
          // A constructor held in a field - pg-pool's `this.Promise` - is
          // invoked with `new` and read for statics (`this.Promise.reject`);
          // the traced wrapper supports neither.
          !isConstructor(attributeValue) &&
          // A callable *object* - a Mongoose model, an Axios instance, an
          // EventEmitter-backed client - is a field, not a method. The traced
          // wrapper is a fresh bound function, so wrapping one silently drops
          // everything hanging off it (`svc.model.find` became undefined
          // mid-trace). This subsumes the Axios special case that used to sit
          // here: an Axios instance is a bound `request` carrying its API as
          // own properties.
          !isCallableObject(attributeValue) &&
          // Handed out as it is, so it still runs against the proxy: the
          // `this.validate()` inside `transform` comes back through here.
          !(partlyTraced && isLibraryInternal(target, prop));
        if (!shouldProxy) {
          // Remembered, as a wrapped method is: telling them apart reads the
          // function's source and its prototype's keys, which a Mongoose
          // model read on every query would otherwise pay each time.
          passedThrough.add(attributeValue);
          return attributeValue;
        }

        const className = classNameOf(target);
        const methodName = String(prop);
        const frameName = `${className}.${methodName}`;

        // For a private-member class, `Reflect.get` with the proxy as receiver
        // would already throw on an accessor that touches `this.#x`, so the
        // value fetched against the target above is reused instead.
        const originalMethod = requiresRawReceiver
          ? attributeValue
          : Reflect.get(target, prop, receiver);
        const tracedReceiver = requiresRawReceiver ? target : proxy;
        // The wrapper is made once per method of this instance and cached
        // below, so a flag of its own guards exactly that callable - checked
        // and flipped on every traced call, where a lookup keyed by instance
        // and name used to be.
        let active = false;
        const tracedFn = createTracedWrapper({
          className,
          methodName,
          spanId: generateSpanId(target, methodName),
          isActive: () => active,
          setActive: (value) => (active = value),
          isAsync: types.isAsyncFunction(originalMethod),
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

        // A method read off the provider is not always called on it. ioredis
        // copies a client's custom commands onto every `Pipeline` it makes
        // (`this[name] = redis[name]`), and each queues on the `this` it is
        // called with: run against the client regardless, a command written
        // into `multi()` was sent at once, outside the transaction. Called on
        // another object, the method runs as it would without the proxy -
        // against that object, untraced. Called on the provider, or on
        // nothing, it is traced against the receiver chosen above.
        //
        // Bound, so V8 prints the trap's frame as top-level, under its name:
        // called as the handler's `apply`, it would carry "[as apply]".
        const apply = named(
          frameName,
          (_target: unknown, thisArg: unknown, args: unknown[]) =>
            thisArg === proxy ||
            thisArg === target ||
            thisArg === undefined ||
            thisArg === null
              ? tracedFn(thisArg, args)
              : Reflect.apply(originalMethod, thisArg, args),
        ).bind(undefined);

        // A proxy of the method itself, so `name`, `length` and everything
        // else read off it are the original's, to anything reflecting over it
        // (DI, decorators, arity checks). Metadata is held by identity, so it
        // is copied onto the proxy.
        const wrapped = new Proxy(originalMethod, { apply });
        const metadataKeys = Reflect.getMetadataKeys(originalMethod);
        for (const key of metadataKeys) {
          const metadata = Reflect.getMetadata(key, originalMethod);
          Reflect.defineMetadata(key, metadata, wrapped);
        }

        methodRefsCache.set(attributeValue, wrapped);
        return wrapped;
      },
      // An assignment made on the provider runs a setter against the raw
      // instance, as a read runs a getter: one that writes `this.#x` threw
      // "Cannot write private member" with the proxy as `this`. Only for the
      // classes whose methods get the raw instance; an object that inherits
      // from the proxy assigns to itself, as it would without it.
      ...(requiresRawReceiver && {
        set: (
          target: object,
          prop: string | symbol,
          value: unknown,
          receiver: unknown,
        ) =>
          receiver === proxy
            ? Reflect.set(target, prop, value)
            : Reflect.set(target, prop, value, receiver),
      }),
    });
    // The raw instance only reaches the methods read through the proxy. A
    // caller that reads one off the class prototype and applies it to the
    // proxy - as `@nestjs/graphql` does with a resolver's - has to be handed
    // the instance, and finds it through `rawReceiverOf`.
    if (requiresRawReceiver) {
      registerRawReceiver(proxy, instance);
    }
    return proxy;
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
 * Whether a property is an own data property that is neither writable nor
 * configurable: what `Object.freeze` makes of every member, and what
 * `Object.defineProperty(obj, key, { value })` creates by default.
 *
 * A proxy's `get` trap has to answer a read of such a property with the
 * target's own value. The engine compares the two after the trap returns and
 * throws a TypeError when they differ ("'get' on proxy: property ... is a
 * read-only and non-configurable data property on the proxy target but the
 * proxy did not return its actual value"), so a traced wrapper in its place
 * failed the read itself, before anything was called.
 *
 * A method found on the prototype has no own descriptor, so a class instance
 * keeps its spans.
 */
function isReadOnlyOwnValue(target: object, prop: string | symbol): boolean {
  const own = Reflect.getOwnPropertyDescriptor(target, prop);
  return (
    own !== undefined && own.configurable === false && own.writable === false
  );
}

/**
 * Whether `promise.then` is the native method: no override on a subclass, no
 * `then` of the promise's own. Calling the native one only registers the
 * callbacks; calling anything else runs code the promise brought with it.
 */
function hasNativeThen(promise: Promise<unknown>): boolean {
  try {
    return promise.then === Promise.prototype.then;
  } catch {
    // A `then` getter that throws: nothing to watch it by.
    return false;
  }
}

/** Runs span bookkeeping whose failure must not reach the caller. */
function ignoreFailure(fn: () => unknown): void {
  try {
    fn();
  } catch {
    // The span is a side effect of the call, not part of its outcome.
  }
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
 *
 * An error with a long `name` and `message` is left as it is - see
 * `MAX_RELABELLED_HEADER_LENGTH`.
 */
function relabelProxyFrame(
  err: unknown,
  className: string,
  methodName: string,
): void {
  // The label is cosmetic, so nothing here may take the place of the error
  // the method threw: a `stack` that is a getter can throw on being read, as
  // a read-only one throws on being written.
  try {
    // Measured first: reading `stack` is what writes it out.
    if (
      !(err instanceof Error) ||
      stackHeaderLength(err) > MAX_RELABELLED_HEADER_LENGTH
    ) {
      return;
    }
    const stack: unknown = err.stack;
    if (typeof stack !== "string") {
      return;
    }
    // `async` prefixes the type name on frames resumed from an await. Spaces
    // and tabs only after the newline, not `\s`: a newline matched there too,
    // and a message of newlines then rescanned the run after each one.
    const frame = new RegExp(
      `(\\n[ \\t]*at (?:async )?)Proxy\\.${escapeRegExp(methodName)}\\b`,
    );
    if (!frame.test(stack)) {
      return;
    }
    err.stack = stack.replace(frame, `$1${className}.${methodName}`);
  } catch {
    // Left as it is.
  }
}

/**
 * The longest `name` plus `message` of an error whose stack is relabelled.
 *
 * V8 writes an error's stack out when it is first read, opening it with the
 * two. Until then a message that quotes the request - `Unknown id ${id}` - is
 * a reference to the text it quotes, however long, and the frames are held in
 * a compact form. Searching the stack writes all of it out, and the copy stays
 * on the error as long as anything holds it: one call per element of a
 * client's array, each failing with a long quote, then held by
 * `Promise.allSettled`, held a copy each. The label is cosmetic, so an error
 * past this keeps `Proxy.` rather than cost that.
 */
const MAX_RELABELLED_HEADER_LENGTH = 1024;

function stackHeaderLength(err: Error): number {
  try {
    return (
      (typeof err.name === "string" ? err.name.length : 0) +
      (typeof err.message === "string" ? err.message.length : 0)
    );
  } catch {
    // A getter that throws; leave such an error alone.
    return Infinity;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a function is meant to be invoked with `new`: a `class`, or a
 * constructor that predates the syntax - a built-in like `Promise`, or an
 * ES5-style (or down-compiled) class - told apart by a `prototype` carrying
 * members of its own. Methods have no `prototype` at all, and a plain
 * `function` gets one holding only `constructor`.
 */
function isConstructor(value: AnyFunction): boolean {
  if (/^\s*class\s+/.test(Function.prototype.toString.call(value))) {
    return true;
  }
  const prototype: unknown = value.prototype;
  return (
    typeof prototype === "object" &&
    prototype !== null &&
    Reflect.ownKeys(prototype).some((key) => key !== "constructor")
  );
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
 *
 * The `Intl` services are read off the namespace instead of being spelled
 * out, see `intlServicePrototypes()`.
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
  ...intlServicePrototypes(),
]);

/**
 * Prototypes of the `Intl` services (`NumberFormat`, `DateTimeFormat`,
 * `Collator`, `PluralRules`, `Locale`, ...). Their methods, and the `format`
 * and `compare` accessors that hand out a bound function, read
 * `[[InitializedNumberFormat]]` and the like off their receiver, so a
 * formatter registered as a provider threw "called on incompatible receiver"
 * on its first use.
 *
 * Which services there are depends on the runtime - `DurationFormat` only
 * arrived in Node 23, and a Node built without ICU has no `Intl` at all - so
 * the constructors are collected from the namespace. Its plain functions
 * (`getCanonicalLocales`, `supportedValuesOf`) have no `prototype`.
 */
function intlServicePrototypes(): object[] {
  if (typeof Intl === "undefined") {
    return [];
  }
  return Object.getOwnPropertyNames(Intl).flatMap((name) => {
    const service: unknown = Reflect.get(Intl, name);
    const prototype: unknown =
      typeof service === "function" ? service.prototype : undefined;
    return typeof prototype === "object" && prototype !== null
      ? [prototype]
      : [];
  });
}

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
 * Whether an instance is a Node stream: a `Readable`, `Writable` or anything
 * built on them (an `IncomingMessage`, a socket, a zlib or file stream), and
 * the legacy `Stream` under an `OutgoingMessage`.
 *
 * Matched by shape as well as by class: `readable-stream` is the same code
 * published to npm, its current major no longer extends Node's `Stream`, and
 * its async iterator makes the same identity check. The state object is what
 * every copy's methods reach for first.
 */
function isNodeStream(instance: object): boolean {
  if (instance instanceof Stream) {
    return true;
  }
  const candidate = instance as {
    _readableState?: unknown;
    _writableState?: unknown;
  };
  return (
    (typeof candidate._readableState === "object" &&
      candidate._readableState !== null) ||
    (typeof candidate._writableState === "object" &&
      candidate._writableState !== null)
  );
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

const privateMemberCache = new WeakMap<object, boolean>();

/**
 * What a compiler leaves of `#name` when the target is below ES2022: the
 * member moves into a `WeakMap` or `WeakSet` keyed by the instance, and every
 * access goes through a helper that checks its receiver against it. That is
 * the same brand check, with no `#` left in the class source.
 *
 * Covers the helpers of tsc and tslib (`__classPrivateFieldGet`), Babel and
 * oxc (`_classPrivateFieldGet2`, `_assertClassBrand`), SWC
 * (`_class_private_field_get`) and esbuild (`__privateGet`). Matched anywhere
 * in a name, since an imported helper is reached through a namespace or under
 * a numbered alias (`tslib_1.__classPrivateFieldGet`). Not the loose-mode
 * helpers of Babel and SWC (`_classPrivateFieldLooseBase`): loose mode keeps
 * the member on the instance under a string key, which reads through the
 * proxy like any other property.
 */
const COMPILED_PRIVATE_MEMBER =
  /classPrivate(?:Field|Method|Getter|Setter)(?!Loose)|assertClassBrand|class_private_(?:field|method)_(?!loose)|__private(?:Get|Set|Add|Method|In|Wrapper)\b/;

/**
 * Whether any class in the instance's prototype chain declares private
 * members (`#field`, `#method()`), native or compiled away.
 *
 * Detection reads the class source: private members can only be touched from
 * inside the lexical class body, so a class whose text contains no `#name`
 * token cannot perform a brand check. A `#` inside a string or comment can
 * false-positive, which merely selects the raw-instance receiver - every call
 * still works, only nested self-call spans are lost - so the cheap test is
 * safe to lean on.
 *
 * A compiled class is told by its helper calls, under the same trade-off:
 * they stay in the class body, where the `#name` was. A `WeakMap` keyed by
 * `this` that an application writes by hand leaves no such trace, and is not
 * covered.
 */
function usesPrivateMembers(instance: object): boolean {
  let proto: object | null = Object.getPrototypeOf(instance);
  while (proto && proto !== Object.prototype) {
    let hasPrivate = privateMemberCache.get(proto);
    if (hasPrivate === undefined) {
      hasPrivate = prototypeUsesPrivateMembers(proto);
      privateMemberCache.set(proto, hasPrivate);
    }
    if (hasPrivate) {
      return true;
    }
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/**
 * Whether the class a prototype belongs to declares native private members.
 *
 * `constructor` leads to that class only while it is the one the class
 * definition put there, which is when its `prototype` is this very object. A
 * helper that mixes classes in by copying the own properties of their
 * prototypes - the TypeScript handbook's `applyMixins`, ioredis's
 * `applyMixin` - copies `constructor` along, and the receiving prototype then
 * names the last class mixed in, whose source says nothing about the one
 * being inspected. That one's own body can no longer be reached from here,
 * but its methods and accessors can: each one's text is a part of the class
 * body, and a brand check made on `this` shows in it.
 */
function prototypeUsesPrivateMembers(proto: object): boolean {
  const ctor: unknown = Object.hasOwn(proto, "constructor")
    ? (Object.getOwnPropertyDescriptor(proto, "constructor")?.value as unknown)
    : undefined;
  if (typeof ctor === "function" && ctor.prototype === proto) {
    return ctor !== Object && declaresPrivateMembers(ctor);
  }
  return Reflect.ownKeys(proto).some((key) => {
    if (key === "constructor") {
      return false;
    }
    // Read as descriptors, so that no getter runs.
    const descriptor = Reflect.getOwnPropertyDescriptor(proto, key);
    return [descriptor?.value, descriptor?.get, descriptor?.set].some(
      (member) =>
        typeof member === "function" && declaresPrivateMembers(member),
    );
  });
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
function declaresPrivateMembers(fn: Function): boolean {
  try {
    const source = Function.prototype.toString.call(fn);
    // `#` starting a private name is never preceded by an identifier
    // character; `obj.#x` and `#x in obj` and declarations all match.
    return (
      /(^|[^\w$])#[\w$]/.test(source) || COMPILED_PRIVATE_MEMBER.test(source)
    );
  } catch {
    // A function whose source is unavailable (bound functions, some
    // natives) cannot be a class body with private members.
    return false;
  }
}

/**
 * The class name that labels an instance's spans. A null-prototype object or
 * an ES module namespace has no `constructor`, and some objects hold a
 * non-function there. Both fall back to `Object`. An `ioredis` client is
 * named for what it is - see `ioredisClassNameOf`.
 */
function classNameOf(instance: object): string {
  const ctor: unknown = Reflect.get(instance, "constructor");
  if (typeof ctor !== "function") {
    return FALLBACK_CLASS_NAME;
  }
  return (
    (ctor.name === "EventEmitter" && ioredisClassNameOf(instance)) || ctor.name
  );
}

/**
 * `Redis` or `Cluster` for an `ioredis` client, null for anything else.
 *
 * Both classes take `EventEmitter`'s methods by copying the own properties of
 * its prototype onto theirs, `constructor` included, so a client's
 * `constructor` is `EventEmitter` and every command would be labelled
 * `EventEmitter.get`. Both extend ioredis's `Commander`, whose prototype keeps
 * its own `constructor`, and a client has `sendCommand`.
 *
 * Matched by name and shape only, as `isMongoDriverHandle` is: ioredis is an
 * application's dependency, never imported here, and an application may carry
 * more than one copy of it - BullMQ and Bull bring their own.
 */
function ioredisClassNameOf(instance: object): string | null {
  try {
    const candidate = instance as {
      sendCommand?: unknown;
      isCluster?: unknown;
    };
    const base = Object.getPrototypeOf(Object.getPrototypeOf(instance)) as {
      constructor?: { name?: unknown };
    } | null;
    if (
      base?.constructor?.name !== "Commander" ||
      typeof candidate.sendCommand !== "function"
    ) {
      return null;
    }
    return candidate.isCluster === true ? "Cluster" : "Redis";
  } catch {
    // A prototype or a property that cannot be read names nothing.
    return null;
  }
}

function generateSpanId(instance: object, methodKey: string): string {
  return `${classNameOf(instance)}#${methodKey}`;
}
