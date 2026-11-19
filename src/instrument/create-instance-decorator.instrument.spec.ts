import * as common from "@nestjs/common";
import { ParseFilePipe, ParseIntPipe, ValidationPipe } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AsyncLocalStorage } from "async_hooks";
import { EventEmitter } from "events";
import { Cluster, Redis } from "ioredis";
import { Db, MongoClient } from "mongodb";
import { CALLER_METADATA_KEY } from "../observe.constants.js";
import {
  createHmac,
  createSecretKey,
  subtle,
  X509Certificate,
} from "node:crypto";
import { PassThrough } from "node:stream";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TracerService } from "../services/tracer.service.js";
import { createInstanceDecorator } from "./create-instance-decorator.instrument.js";

const TRACE_ID_KEY = "traceId";

describe("createInstanceDecorator", () => {
  let als: AsyncLocalStorage<Map<string, any>>;
  let startedSteps: Array<{ className: string; methodName: string }>;
  let endedSteps: Array<{
    spanId: string;
    error?: unknown;
    stackAtRecord?: string;
  }>;
  let endFailure: Error | undefined;
  let decorate: (instance: unknown) => unknown;

  const withTrace = <T>(fn: () => T): T =>
    als.run(new Map([[TRACE_ID_KEY, "trace-1"]]), fn);

  beforeEach(() => {
    als = new AsyncLocalStorage();
    startedSteps = [];
    endedSteps = [];
    endFailure = undefined;

    const registry = {
      internalStartTraceStep: (
        _traceId: string,
        className: string,
        methodName: string,
      ) => {
        startedSteps.push({ className, methodName });
        return `step-${startedSteps.length}`;
      },
      internalEndTraceStep: (
        _traceId: string,
        spanId: string,
        _className: string,
        _methodName: string,
        _callerId: string,
        error?: unknown,
      ) => {
        if (endFailure) {
          throw endFailure;
        }
        // Snapshot the stack as the real registry does - it serializes it into
        // the span payload at this moment, not by holding on to the error.
        endedSteps.push({
          spanId,
          error,
          stackAtRecord: error instanceof Error ? error.stack : undefined,
        });
      },
    } as unknown as OperationTraceRegistry;

    decorate = createInstanceDecorator(als, registry, {
      traceIdKey: TRACE_ID_KEY,
      skipInstrumentation: () => false,
    });
  });

  describe("when decorating a class instance", () => {
    class UserService {
      readonly calls: unknown[][] = [];

      findAll(...args: unknown[]) {
        this.calls.push(args);
        return "ok";
      }

      fail() {
        throw new Error("boom");
      }

      async findAsync() {
        return "async-ok";
      }

      store(_req: unknown, _meta: unknown, _done: unknown) {
        return "stored";
      }
    }

    it("records a trace step named after the class and method", () => {
      const service = decorate(new UserService()) as UserService;

      const result = withTrace(() => service.findAll(1, 2));

      expect(result).toEqual("ok");
      expect(startedSteps).toEqual([
        { className: "UserService", methodName: "findAll" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "UserService#findAll" }]);
    });

    it("names stack frames after the class instead of Proxy", () => {
      const service = decorate(new UserService()) as UserService;

      const stack = withTrace(() => {
        try {
          service.fail();
          return "";
        } catch (err) {
          return (err as Error).stack ?? "";
        }
      });

      // Frames contributed by the instrumentation itself must read like the
      // call the user made, not "Proxy.<something>".
      const instrumentationFrames = stack
        .split("\n")
        .filter((line) =>
          /create-instance-decorator\.instrument\.ts/.test(line),
        );

      expect(instrumentationFrames.length).toBeGreaterThan(0);
      for (const frame of instrumentationFrames) {
        expect(frame).toContain("UserService.fail");
        expect(frame).not.toContain("Proxy");
      }
    });

    it("relabels the throwing method's own frame", () => {
      const service = decorate(new UserService()) as UserService;

      const stack = withTrace(() => {
        try {
          service.fail();
          return "";
        } catch (err) {
          return (err as Error).stack ?? "";
        }
      });

      // The frame for `fail` itself runs with the proxy as its receiver, so V8
      // names it "Proxy.fail" - it has to be rewritten after the fact.
      expect(stack.split("\n")[1]).toContain("UserService.fail");
      expect(stack).not.toContain("Proxy.fail");
    });

    it("relabels each frame with its own class when method names collide", () => {
      class OrderService {
        constructor(private readonly users: UserService) {}

        fail() {
          this.users.fail();
        }
      }

      const users = decorate(new UserService()) as UserService;
      const orders = decorate(new OrderService(users)) as OrderService;

      const stack = withTrace(() => {
        try {
          orders.fail();
          return "";
        } catch (err) {
          return (err as Error).stack ?? "";
        }
      });

      const specFrames = stack
        .split("\n")
        .filter((line) =>
          /create-instance-decorator\.instrument\.spec\.ts/.test(line),
        )
        .filter((line) => /\.fail /.test(line));

      expect(stack).not.toContain("Proxy.fail");
      // Innermost first: the caller must not inherit the callee's class name.
      expect(specFrames[0]).toContain("UserService.fail");
      expect(
        specFrames.some((frame) => frame.includes("OrderService.fail")),
      ).toBe(true);
    });

    it("relabels before the step is recorded, including the root span", () => {
      class OrderService {
        constructor(private readonly users: UserService) {}

        fail() {
          this.users.fail();
        }
      }

      const users = decorate(new UserService()) as UserService;
      const orders = decorate(new OrderService(users)) as OrderService;

      expect(() => withTrace(() => orders.fail())).toThrow("boom");

      // The root span records last and is the payload the error group samples,
      // so the stack it captured must already be free of "Proxy.".
      const rootStep = endedSteps[endedSteps.length - 1];
      expect(rootStep.spanId).toEqual("OrderService#fail");
      expect(rootStep.stackAtRecord).not.toContain("Proxy.");
      expect(rootStep.stackAtRecord).toContain("OrderService.fail");
      expect(rootStep.stackAtRecord).toContain("UserService.fail");
    });

    it("relabels frames in linear time when the message is mostly newlines", () => {
      // `\s*` after the newline that opens a frame also matched newlines, so
      // every newline of a message rescanned the run after it - quadratic,
      // per traced frame, on text a client chose. ~1.3 s for this input.
      class InnerService {
        fail(input: string) {
          throw new Error(`invalid: ${input}`);
        }
      }
      class OuterService {
        constructor(private readonly inner: InnerService) {}
        fail(input: string) {
          this.inner.fail(input);
        }
      }
      const outer = decorate(
        new OuterService(decorate(new InnerService()) as InnerService),
      ) as OuterService;
      const input = "\n".repeat(20_000);
      const startedAt = performance.now();

      expect(() => withTrace(() => outer.fail(input))).toThrow("invalid");

      expect(performance.now() - startedAt).toBeLessThan(100);
    });

    it("does not write out the stack of an error with a long message", () => {
      // V8 writes a stack out when it is first read, with the message the
      // error has by then - so a stack that opens with a changed message was
      // not read before the change. Read, each error held in a loop keeps a
      // copy of the text its message quotes.
      class LookupService {
        find(name: string) {
          throw new Error(`No user named "${name}"`);
        }
      }
      const service = createInstanceDecorator(
        als,
        {
          internalStartTraceStep: () => "step-1",
          internalEndTraceStep: () => undefined,
        } as unknown as OperationTraceRegistry,
        { traceIdKey: TRACE_ID_KEY, skipInstrumentation: () => false },
      )(new LookupService()) as LookupService;
      const lookUp = (name: string) =>
        withTrace(() => {
          try {
            service.find(name);
          } catch (err) {
            return err as Error;
          }
          throw new Error("find() did not throw");
        });

      const long = lookUp("a".repeat(2_000));
      long.message = "changed";
      expect(long.stack).toMatch(/^Error: changed\n/);

      const short = lookUp("a");
      short.message = "changed";
      expect(short.stack).toMatch(/^Error: No user named "a"\n/);
      expect(short.stack).not.toContain("Proxy.find");
    });

    it("throws the method's own error when its stack cannot be read", () => {
      const thrown = new Error("upstream refused");
      Object.defineProperty(thrown, "stack", {
        get() {
          throw new TypeError("stack getter failed");
        },
      });
      class UpstreamService {
        call() {
          throw thrown;
        }
      }
      const service = createInstanceDecorator(
        als,
        {
          internalStartTraceStep: () => "step-1",
          internalEndTraceStep: () => undefined,
        } as unknown as OperationTraceRegistry,
        { traceIdKey: TRACE_ID_KEY, skipInstrumentation: () => false },
      )(new UpstreamService()) as UpstreamService;

      let caught: unknown;
      withTrace(() => {
        try {
          service.call();
        } catch (err) {
          caught = err;
        }
      });

      expect(caught).toBe(thrown);
    });

    it("keeps the original method name on the returned wrapper", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll.name).toEqual("findAll");
    });

    it("keeps the original arity on the returned wrapper", () => {
      // Libraries such as passport-oauth2 read `fn.length` to choose which
      // arguments to pass, thus a wrapper reporting 0 changes the call.
      const service = decorate(new UserService()) as UserService;

      expect(service.store.length).toEqual(3);
    });

    it("forwards arguments and preserves `this`", () => {
      const instance = new UserService();
      const service = decorate(instance) as UserService;

      withTrace(() => service.findAll("a", "b"));

      expect(instance.calls).toEqual([["a", "b"]]);
    });

    it("returns the same wrapper for repeated property access", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll).toBe(service.findAll);
    });

    it("runs a getter once per read", () => {
      class Counting {
        reads = 0;
        get value() {
          this.reads += 1;
          return 42;
        }
      }
      const instance = new Counting();
      const counting = decorate(instance) as Counting;

      expect(counting.value).toBe(42);
      expect(withTrace(() => counting.value)).toBe(42);
      expect(instance.reads).toBe(2);
    });

    it("ends the trace step with the error and re-throws", () => {
      const service = decorate(new UserService()) as UserService;

      expect(() => withTrace(() => service.fail())).toThrow("boom");
      expect(endedSteps).toHaveLength(1);
      expect(endedSteps[0].error).toBeInstanceOf(Error);
    });

    it("traces async methods once they settle", async () => {
      const service = decorate(new UserService()) as UserService;

      await expect(withTrace(() => service.findAsync())).resolves.toEqual(
        "async-ok",
      );
      expect(endedSteps).toEqual([{ spanId: "UserService#findAsync" }]);
    });

    describe("when a method returns a promise", () => {
      const settle = () => new Promise((resolve) => setImmediate(resolve));

      class PromiseService {
        withMember<P extends Promise<string>>(promise: P): P {
          return promise;
        }

        async awaited(promise: Promise<string>): Promise<string> {
          return promise;
        }

        /** Handles its own failure, so a caller may fire and forget. */
        selfHandled(promise: Promise<string>): Promise<string> {
          promise.catch(() => undefined);
          return promise;
        }
      }

      /** A promise in the style of a `got` request or a cancelable one. */
      const withMembers = <T>(promise: Promise<T>) =>
        Object.assign(promise, { cancel: () => undefined });

      /**
       * Collects the `unhandledRejection` events `fn` raises. Vitest's own
       * listener fails the run on any of them, so it is set aside meanwhile.
       */
      const captureUnhandledRejections = async (fn: () => Promise<void>) => {
        const reasons: unknown[] = [];
        const listener = (reason: unknown) => reasons.push(reason);
        const previous = process.listeners("unhandledRejection");
        process.removeAllListeners("unhandledRejection");
        process.on("unhandledRejection", listener);
        try {
          await fn();
        } finally {
          process.off("unhandledRejection", listener);
          for (const handler of previous) {
            process.on("unhandledRejection", handler);
          }
        }
        return reasons;
      };

      it("chains the promise of an async method, as the caller's own `.then` would", async () => {
        const service = decorate(new PromiseService()) as PromiseService;

        const returned = withTrace(() => service.awaited(Promise.resolve("p")));

        await expect(returned).resolves.toBe("p");
        expect(endedSteps).toEqual([{ spanId: "PromiseService#awaited" }]);
      });

      it("lets a dropped rejection of an async method raise unhandledRejection", async () => {
        const failure = new Error("dropped");
        const service = decorate(new PromiseService()) as PromiseService;

        const unhandled = await captureUnhandledRejections(async () => {
          void withTrace(() => service.awaited(Promise.reject(failure)));
          await settle();
        });

        expect(unhandled).toEqual([failure]);
        expect(endedSteps[0].error).toBe(failure);
      });

      it("returns the very promise a method that is not async returned", async () => {
        const original = Promise.resolve("p");
        const service = decorate(new PromiseService()) as PromiseService;

        const returned = withTrace(() => service.withMember(original));

        expect(returned).toBe(original);
        await expect(returned).resolves.toBe("p");
        await settle();
        expect(endedSteps).toEqual([{ spanId: "PromiseService#withMember" }]);
      });

      it("raises no unhandledRejection when the method handled the rejection itself", async () => {
        const failure = new Error("handled by the method");
        const service = decorate(new PromiseService()) as PromiseService;

        const unhandled = await captureUnhandledRejections(async () => {
          void withTrace(() => service.selfHandled(Promise.reject(failure)));
          await settle();
        });

        expect(unhandled).toEqual([]);
        expect(endedSteps[0].error).toBe(failure);
      });

      it("raises no unhandledRejection when another caller handles a shared promise", async () => {
        const failure = new Error("handled by another caller");
        const inFlight = Promise.reject<string>(failure);
        const service = decorate(new PromiseService()) as PromiseService;

        const unhandled = await captureUnhandledRejections(async () => {
          const handled = withTrace(() => service.withMember(inFlight)).catch(
            (err: unknown) => err,
          );
          void withTrace(() => service.withMember(inFlight));
          await expect(handled).resolves.toBe(failure);
          await settle();
        });

        expect(unhandled).toEqual([]);
      });

      it("returns the very promise the method returned, members included", async () => {
        const original = withMembers(Promise.resolve("p"));
        const service = decorate(new PromiseService()) as PromiseService;

        const returned = withTrace(() => service.withMember(original));

        expect(returned).toBe(original);
        expect(returned.cancel).toBe(original.cancel);
        await expect(returned).resolves.toBe("p");
        await settle();
        expect(endedSteps).toEqual([{ spanId: "PromiseService#withMember" }]);
      });

      it("records a dropped rejection of a promise with members on the span only", async () => {
        // Watching a promise marks it handled, so this one no longer reaches
        // `unhandledRejection`. Only promises that cannot be swapped pay that.
        const failure = new Error("dropped");
        const service = decorate(new PromiseService()) as PromiseService;

        const unhandled = await captureUnhandledRejections(async () => {
          void withTrace(() =>
            service.withMember(withMembers(Promise.reject(failure))),
          );
          await settle();
        });

        expect(unhandled).toEqual([]);
        expect(endedSteps[0].error).toBe(failure);
      });

      describe("for a promise with a `then` of its own", () => {
        /** In the style of `p-lazy`: the work starts on the first `then`. */
        class LazyPromise<T> extends Promise<T> {
          private started?: Promise<T>;

          constructor(private readonly work: () => T) {
            super((resolve) => resolve(undefined as T));
          }

          // Promise's species is this class, whose constructor takes no
          // executor; the promises `then` derives are plain ones.
          static override get [Symbol.species]() {
            return Promise;
          }

          // oxlint-disable-next-line unicorn/no-thenable -- overriding `then` is the point of the test
          override then<A = T, B = never>(
            onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
            onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
          ): Promise<A | B> {
            this.started ??= new Promise<T>((resolve) => resolve(this.work()));
            return this.started.then(onFulfilled, onRejected);
          }
        }

        it("never starts a lazy promise the caller does not", async () => {
          let runs = 0;
          const original = new LazyPromise(() => `run ${++runs}`);
          const service = decorate(new PromiseService()) as PromiseService;

          const returned = withTrace(() => service.withMember(original));
          await settle();

          expect(returned).toBe(original);
          expect(runs).toBe(0);
        });

        it("ends the span with the call, as for any other thenable", () => {
          const service = decorate(new PromiseService()) as PromiseService;

          void withTrace(() => service.withMember(new LazyPromise(() => "p")));

          expect(endedSteps).toEqual([{ spanId: "PromiseService#withMember" }]);
        });

        it("leaves starting it, and its outcome, to the caller", async () => {
          let runs = 0;
          const failure = new Error("rejected");
          const service = decorate(new PromiseService()) as PromiseService;

          await expect(
            withTrace(() =>
              service.withMember(new LazyPromise(() => `run ${++runs}`)),
            ),
          ).resolves.toBe("run 1");
          await expect(
            withTrace(() =>
              service.withMember(
                new LazyPromise<string>(() => {
                  throw failure;
                }),
              ),
            ),
          ).rejects.toBe(failure);
          expect(runs).toBe(1);
        });
      });

      describe.each<
        [string, (service: PromiseService, promise: Promise<string>) => unknown]
      >([
        ["a plain promise", (service, promise) => service.withMember(promise)],
        [
          "a promise with members",
          (service, promise) => service.withMember(withMembers(promise)),
        ],
        [
          "the promise of an async method",
          (service, promise) => service.awaited(promise),
        ],
      ])("for %s", (_label, callWith) => {
        it("hands the caller the original rejection and records it on the span", async () => {
          const failure = new Error("rejected");
          const service = decorate(new PromiseService()) as PromiseService;
          const returned = withTrace(() =>
            callWith(service, Promise.reject(failure)),
          );

          await expect(returned).rejects.toBe(failure);
          await settle();

          expect(endedSteps).toHaveLength(1);
          expect(endedSteps[0].error).toBe(failure);
        });

        it("ends the span when the promise settles, not when it is returned", async () => {
          let resolveLater!: (value: string) => void;
          const pending = new Promise<string>((resolve) => {
            resolveLater = resolve;
          });
          const service = decorate(new PromiseService()) as PromiseService;

          void withTrace(() => callWith(service, pending));
          await settle();
          expect(endedSteps).toEqual([]);

          resolveLater("done");
          await settle();
          expect(endedSteps).toHaveLength(1);
        });

        it("keeps the caller's value when closing the span throws", async () => {
          endFailure = new Error("registry failed");
          const service = decorate(new PromiseService()) as PromiseService;

          const returned = withTrace(() =>
            callWith(service, Promise.resolve("p")),
          );

          await expect(returned).resolves.toBe("p");
          await settle();
        });

        it("keeps the caller's rejection when closing the span throws", async () => {
          endFailure = new Error("registry failed");
          const failure = new Error("rejected");
          const service = decorate(new PromiseService()) as PromiseService;

          const returned = withTrace(() =>
            callWith(service, Promise.reject(failure)),
          );

          await expect(returned).rejects.toBe(failure);
          await settle();
        });
      });

      it("builds only one derived promise from a Promise subclass", () => {
        let constructed = 0;
        class CountingPromise<T> extends Promise<T> {
          constructor(
            executor: (
              resolve: (value: T | PromiseLike<T>) => void,
              reject: (reason?: unknown) => void,
            ) => void,
          ) {
            super(executor);
            constructed += 1;
          }
        }
        const original = CountingPromise.resolve("p");
        constructed = 0;
        const service = decorate(new PromiseService()) as PromiseService;

        const returned = withTrace(() => service.withMember(original));

        expect(returned).toBe(original);
        // Observing a promise derives one instance through Symbol.species.
        // The old `.then().catch()` chain derived two.
        expect(constructed).toBe(1);
      });
    });

    it("does not record steps outside of an active trace", () => {
      const service = decorate(new UserService()) as UserService;

      expect(service.findAll()).toEqual("ok");
      expect(startedSteps).toEqual([]);
    });

    it("still traces a method that was previously called outside a trace", () => {
      const service = decorate(new UserService()) as UserService;

      service.findAll();
      withTrace(() => service.findAll());

      expect(startedSteps).toEqual([
        { className: "UserService", methodName: "findAll" },
      ]);
    });

    it("scopes the caller to the call, and not the attributes set in it", () => {
      // The call runs in a copy of its caller's store, made so it can name
      // its span as the caller. What a guard sets there with `setAttribute`
      // is for the handler that runs after it.
      const tracer = new TracerService(
        {} as never,
        als as never,
        {} as never,
        { traceIdKey: TRACE_ID_KEY } as never,
      );
      class TenantGuard {
        canActivate() {
          tracer.setAttribute("tenantId", "acme");
          return als.getStore()!.get(CALLER_METADATA_KEY);
        }
      }
      const guard = decorate(new TenantGuard()) as TenantGuard;

      withTrace(() => {
        expect(guard.canActivate()).toBe("step-1");

        expect(als.getStore()!.has(CALLER_METADATA_KEY)).toBe(false);
        expect(tracer.getAttribute("tenantId")).toBe("acme");
      });
    });

    it("never instruments Nest's Reflector", () => {
      // Metadata lookups: several a request, and nothing a waterfall is for.
      const reflector = new Reflector();
      expect(decorate(reflector)).toBe(reflector);

      // A second copy of @nestjs/core has its own class; the shape still
      // gives it away.
      class Reflector2 {
        getAllAndOverride() {
          return undefined;
        }
      }
      Object.defineProperty(Reflector2, "name", { value: "Reflector" });
      const copy = new Reflector2();
      expect(decorate(copy)).toBe(copy);

      withTrace(() => {
        reflector.get("roles", UserService);
        copy.getAllAndOverride();
      });
      expect(startedSteps).toEqual([]);
    });

    it("still instruments a provider that is only called Reflector", () => {
      // The name alone is not enough: an application's own class is traced.
      class Reflector2 {
        reflect() {
          return "mirror";
        }
      }
      Object.defineProperty(Reflector2, "name", { value: "Reflector" });
      const own = decorate(new Reflector2()) as Reflector2;

      withTrace(() => own.reflect());
      expect(startedSteps).toEqual([
        { className: "Reflector", methodName: "reflect" },
      ]);
    });

    it("never instruments the mongodb driver's MongoClient and Db", async () => {
      // Never connected: constructing either one opens no socket.
      const client = new MongoClient("mongodb://127.0.0.1:1");
      const db = client.db("app");
      expect(decorate(client)).toBe(client);
      expect(decorate(db)).toBe(db);

      // A second copy of the driver has its own classes; the shape still
      // gives them away.
      class MongoClient2 {
        startSession() {
          return {};
        }
        db() {
          return {};
        }
      }
      Object.defineProperty(MongoClient2, "name", { value: "MongoClient" });
      class Db2 {
        readonly databaseName = "app";
        collection() {
          return {};
        }
      }
      Object.defineProperty(Db2, "name", { value: "Db" });
      const clientCopy = new MongoClient2();
      const dbCopy = new Db2();
      expect(decorate(clientCopy)).toBe(clientCopy);
      expect(decorate(dbCopy)).toBe(dbCopy);

      await client.close();
    });

    it("never instruments a provider class that extends MongoClient or Db", async () => {
      // `class MongoService extends MongoClient`: proxied, a `Db` made at
      // bootstrap held the raw client and a session started in a traced
      // request the proxy, and the driver refused every explicit session.
      class MongoService extends MongoClient {}
      const client = new MongoService("mongodb://127.0.0.1:1");
      class AppDb extends Db {}
      const db = new AppDb(client, "app");

      expect(decorate(client)).toBe(client);
      expect(decorate(db)).toBe(db);

      await client.close();
    });

    it("still instruments a provider that is only called MongoClient or Db", () => {
      class MongoClient2 {
        connect() {
          return "connected";
        }
      }
      Object.defineProperty(MongoClient2, "name", { value: "MongoClient" });
      class Db2 {
        collection() {
          return "items";
        }
      }
      Object.defineProperty(Db2, "name", { value: "Db" });
      const client = decorate(new MongoClient2()) as MongoClient2;
      const db = decorate(new Db2()) as Db2;

      withTrace(() => {
        client.connect();
        db.collection();
      });
      expect(startedSteps).toEqual([
        { className: "MongoClient", methodName: "connect" },
        { className: "Db", methodName: "collection" },
      ]);
    });

    it("respects skipInstrumentation", () => {
      const instance = new UserService();
      const skipping = createInstanceDecorator(
        als,
        {} as OperationTraceRegistry,
        {
          traceIdKey: TRACE_ID_KEY,
          skipInstrumentation: () => true,
        },
      );

      expect(skipping(instance)).toBe(instance);
    });
  });

  describe("when another object calls a provider's method", () => {
    /**
     * ioredis's `Pipeline` borrows a client's custom commands
     * (`this[name] = redis[name]`), and each queues on the `this` it is
     * called with. Run against the client regardless, a command written into
     * `multi()` was sent at once, outside the transaction.
     */
    class Client {
      readonly log: number[] = [];
      reserve(quantity: number) {
        this.log.push(quantity);
        return this;
      }
      multi() {
        return new Pipeline(this);
      }
    }
    class Pipeline {
      readonly log: number[] = [];
      reserve: Client["reserve"];
      constructor(client: Client) {
        // oxlint-disable-next-line typescript/unbound-method -- borrowed, as ioredis's Pipeline borrows
        this.reserve = client.reserve;
      }
    }

    it.each([
      ["inside a trace", withTrace],
      ["outside a trace", <T>(fn: () => T) => fn()],
    ])(
      "runs a borrowed method against the object it is called on, %s",
      (_, run) => {
        const instance = new Client();
        const client = decorate(instance) as Client;

        const pipeline = run(() => {
          const transaction = client.multi();
          transaction.reserve(50);
          return transaction;
        });

        expect(pipeline.log).toEqual([50]);
        expect(instance.log).toEqual([]);
      },
    );

    it("still traces the provider's own call of a method it lent", () => {
      const client = decorate(new Client()) as Client;

      withTrace(() => client.multi().reserve(1));
      startedSteps = [];
      withTrace(() => client.reserve(2));

      expect(startedSteps).toEqual([
        { className: "Client", methodName: "reserve" },
      ]);
    });

    /**
     * A traced call runs with the proxy as `this`, so what a method derives
     * from `this` - `Object.create(this)`, as pino's `logger.child()` does -
     * inherits from the proxy. The first such object to read a method became
     * the `this` of every later call of it, from any request.
     */
    class Repo {
      tenant = "none";
      forTenant(tenant: string): Repo {
        const scoped = Object.create(this) as Repo;
        scoped.tenant = tenant;
        return scoped;
      }
      list() {
        return `invoices of ${this.tenant}`;
      }
      get label() {
        return `repo of ${this.tenant}`;
      }
    }

    it("runs an inherited method against the object that inherited it", () => {
      const repo = decorate(new Repo()) as Repo;

      expect(withTrace(() => repo.forTenant("acme").list())).toBe(
        "invoices of acme",
      );
      expect(withTrace(() => repo.forTenant("globex").list())).toBe(
        "invoices of globex",
      );
    });

    it("runs it so outside a trace as well", () => {
      const repo = decorate(new Repo()) as Repo;

      const scoped = withTrace(() => repo.forTenant("acme"));

      expect(scoped.list()).toBe("invoices of acme");
    });

    it("still traces the provider's own call once a derived object read the method", () => {
      const repo = decorate(new Repo()) as Repo;

      withTrace(() => repo.forTenant("acme").list());
      startedSteps = [];
      withTrace(() => repo.list());

      expect(startedSteps).toEqual([{ className: "Repo", methodName: "list" }]);
    });

    it("reads an inherited getter against the object that inherited it", () => {
      const repo = decorate(new Repo()) as Repo;

      expect(withTrace(() => repo.forTenant("acme").label)).toBe(
        "repo of acme",
      );
    });
  });

  describe("when a field holds a callable object", () => {
    /** Shaped like a compiled Mongoose model: callable, statics, custom proto. */
    const makeModel = () => {
      class BaseModel {}
      function ProbeModel() {}
      Object.setPrototypeOf(ProbeModel, BaseModel);
      (ProbeModel as unknown as { find: () => string }).find = () => "found";
      return ProbeModel as unknown as { find: () => string };
    };

    class Repository {
      model = makeModel();

      findAll() {
        return this.model.find();
      }
    }

    it("hands the callable out untouched, statics intact", () => {
      const raw = new Repository();
      const repo = decorate(raw) as Repository;

      // A traced wrapper would be a fresh function with none of the statics -
      // `svc.model.find` was undefined whenever a trace was active.
      expect(withTrace(() => repo.model)).toBe(raw.model);
      expect(withTrace(() => repo.model.find())).toEqual("found");
    });

    it("traces the method but not the model it calls through", () => {
      const repo = decorate(new Repository()) as Repository;

      const result = withTrace(() => repo.findAll());

      expect(result).toEqual("found");
      expect(startedSteps).toEqual([
        { className: "Repository", methodName: "findAll" },
      ]);
    });

    it("skips a plain function carrying own enumerable properties", () => {
      const client = () => "call";
      client.get = () => "static";
      const raw = { client };
      const wrapped = decorate(raw) as typeof raw;

      expect(withTrace(() => wrapped.client)).toBe(client);
      expect(withTrace(() => wrapped.client.get())).toEqual("static");
    });

    it("hands out an Axios-shaped instance untouched", () => {
      // An Axios instance is `Axios.prototype.request` bound, with the API
      // (`get`, `post`, `Axios`, ...) copied on as own properties. The
      // structural check covers it - no special case needed.
      // The bind is the point, not an accident: a real Axios instance is a
      // bound function, and bound functions are shaped unlike plain ones (no
      // `prototype` own property), so the structural check must see one.
      function baseRequest() {
        return "response";
      }
      const request = baseRequest.bind(undefined) as {
        (): string;
        get?: () => string;
      };
      Object.assign(request, { get: () => "got", Axios: class Axios {} });
      const raw = { http: request as typeof request & { get: () => string } };
      const wrapped = decorate(raw) as typeof raw;

      expect(withTrace(() => wrapped.http)).toBe(raw.http);
      expect(withTrace(() => wrapped.http.get())).toEqual("got");
    });

    it("still traces async methods despite their distinct prototype", () => {
      class AsyncService {
        async load() {
          return "loaded";
        }
      }
      const service = decorate(new AsyncService()) as AsyncService;

      return withTrace(() => service.load()).then((result: string) => {
        expect(result).toEqual("loaded");
        // AsyncFunction.prototype is not Function.prototype; the callable-
        // object check must not mistake ordinary async methods for fields.
        expect(startedSteps).toEqual([
          { className: "AsyncService", methodName: "load" },
        ]);
      });
    });
  });

  describe("when a field holds a constructor", () => {
    it("hands out a native constructor untouched, statics intact", () => {
      // pg-pool keeps `this.Promise = options.Promise || global.Promise` and
      // calls `new this.Promise(...)` and `this.Promise.reject(...)` - both
      // broke once the field came back as a traced wrapper.
      const raw = { Promise };
      const wrapped = decorate(raw) as typeof raw;

      expect(withTrace(() => wrapped.Promise)).toBe(Promise);
      expect(
        withTrace(() => new wrapped.Promise((resolve) => resolve(1))),
      ).toBeInstanceOf(Promise);
      expect(startedSteps).toEqual([]);
    });

    it("hands out an ES5-style constructor untouched", () => {
      function Legacy(this: { value: number }) {
        this.value = 1;
      }
      Legacy.prototype.read = function () {
        return this.value;
      };
      const raw = { Legacy };
      const wrapped = decorate(raw) as typeof raw;

      expect(withTrace(() => wrapped.Legacy)).toBe(Legacy);
    });

    it("keeps handing the constructor out untouched on later reads", () => {
      const raw = { Promise };
      const wrapped = decorate(raw) as typeof raw;

      const reads = withTrace(() => [wrapped.Promise, wrapped.Promise]);

      expect(reads).toEqual([Promise, Promise]);
      expect(wrapped.Promise).toBe(Promise);
      expect(startedSteps).toEqual([]);
    });

    it("runs a real pg.Pool query registered as a provider", async () => {
      const { default: pg } = await import("pg");
      // Stands in for a connection so the pool can check one out offline.
      class StubClient extends EventEmitter {
        connect(cb: (err?: Error) => void) {
          cb();
        }
        query(...args: unknown[]) {
          const cb = args.at(-1) as (err: Error | null, res: unknown) => void;
          cb(null, { rows: [{ ok: 1 }] });
        }
        end(cb?: () => void) {
          cb?.();
        }
      }
      const pool = decorate(
        new pg.Pool({ Client: StubClient } as never),
      ) as InstanceType<typeof pg.Pool>;

      const result = await withTrace(() => pool.query("SELECT 1"));

      expect(result.rows).toEqual([{ ok: 1 }]);
      // The pool's own `this.connect()` & co. follow as nested steps.
      expect(startedSteps[0]).toEqual({
        className: "BoundPool",
        methodName: "query",
      });
      await pool.end();
    });
  });

  describe("when the registry has no snapshot for the trace id", () => {
    class HealthService {
      check() {
        return "ok";
      }
    }

    let endCalls: number;
    let noSnapshotDecorate: (instance: unknown) => unknown;

    beforeEach(() => {
      endCalls = 0;
      // A request dropped by `http.ignore` or sampled out still carries its
      // trace id in the store (log correlation reads it there), but the
      // registry never opened a snapshot: internalStartTraceStep misses.
      const registry = {
        internalStartTraceStep: () => undefined,
        internalEndTraceStep: () => {
          endCalls += 1;
        },
      } as unknown as OperationTraceRegistry;
      noSnapshotDecorate = createInstanceDecorator(als, registry, {
        traceIdKey: TRACE_ID_KEY,
        skipInstrumentation: () => false,
      });
    });

    it("runs the method without trying to close a step that never opened", () => {
      const service = noSnapshotDecorate(new HealthService()) as HealthService;

      const result = withTrace(() => service.check());

      expect(result).toEqual("ok");
      // Closing anyway is what logged "No snapshot found for traceId" once
      // per provider call - ~10 ERROR lines per readiness probe.
      expect(endCalls).toBe(0);
    });

    it("clears the re-entrancy flag so later calls still run", () => {
      const service = noSnapshotDecorate(new HealthService()) as HealthService;

      withTrace(() => service.check());

      expect(withTrace(() => service.check())).toEqual("ok");
      expect(endCalls).toBe(0);
    });
  });

  describe("when opening a step throws", () => {
    class EscapeService {
      escape(text: string) {
        return text.replace(/</g, "&lt;");
      }
    }

    it("still traces the method's later calls", () => {
      // A request nested a few levels past the deepest body an application
      // accepts runs out of stack between setting the re-entrancy flag and
      // entering the span: the flag stayed set, and the method was never
      // traced again until the process restarted.
      let overflow = true;
      const started: string[] = [];
      const registry = {
        internalStartTraceStep: (_: string, __: string, methodName: string) => {
          if (overflow) {
            overflow = false;
            throw new RangeError("Maximum call stack size exceeded");
          }
          started.push(methodName);
          return `step-${started.length}`;
        },
        internalEndTraceStep: () => undefined,
      } as unknown as OperationTraceRegistry;
      const service = createInstanceDecorator(als, registry, {
        traceIdKey: TRACE_ID_KEY,
        skipInstrumentation: () => false,
      })(new EscapeService()) as EscapeService;

      expect(() => withTrace(() => service.escape("<a>"))).toThrow(RangeError);
      expect(withTrace(() => service.escape("<b>"))).toBe("&lt;b>");

      expect(started).toEqual(["escape"]);
    });
  });

  describe("when decorating a pipe", () => {
    class CreateOrderDto {}

    /** The packages `ValidationPipe` would otherwise load, which it can be handed. */
    const validationPipe = (validate: () => unknown[] = () => []) =>
      new ValidationPipe({
        transform: true,
        validatorPackage: { validate } as never,
        transformerPackage: {
          plainToInstance: (_type: unknown, value: unknown) => value,
          classToPlain: (value: unknown) => value,
        } as never,
      });

    const steps = () =>
      startedSteps.map((step) => `${step.className}.${step.methodName}`);

    it("makes no span for a ValidationPipe run that validates nothing", async () => {
      const pipe = decorate(validationPipe()) as ValidationPipe;

      await expect(
        withTrace(() =>
          pipe.transform("7", { type: "param", metatype: Number, data: "id" }),
        ),
      ).resolves.toBe(7);
      expect(steps()).toEqual([]);
    });

    it("traces only `validate` when a ValidationPipe validates", async () => {
      const pipe = decorate(validationPipe()) as ValidationPipe;

      await withTrace(() =>
        pipe.transform(
          { total: 1 },
          { type: "body", metatype: CreateOrderDto },
        ),
      );
      expect(steps()).toEqual(["ValidationPipe.validate"]);
    });

    it("still refuses what fails validation", async () => {
      const pipe = decorate(
        validationPipe(() => [
          { property: "total", constraints: { isInt: "total must be an int" } },
        ]),
      ) as ValidationPipe;

      await expect(
        withTrace(() =>
          pipe.transform({}, { type: "body", metatype: CreateOrderDto }),
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(steps()).toEqual(["ValidationPipe.validate"]);
    });

    it("traces only `validate` on ParseFilePipe", async () => {
      const pipe = decorate(
        new ParseFilePipe({
          validators: [{ isValid: () => true } as never],
        }),
      ) as ParseFilePipe;

      await withTrace(() => pipe.transform({ size: 1 }));
      expect(steps()).toEqual(["ParseFilePipe.validate"]);
    });

    // Not in every supported @nestjs/common.
    const { StandardSchemaValidationPipe } = common as unknown as {
      StandardSchemaValidationPipe?: new () => {
        transform(value: unknown, metadata: unknown): Promise<unknown>;
      };
    };
    (StandardSchemaValidationPipe ? it : it.skip)(
      "traces only `validate` on StandardSchemaValidationPipe",
      async () => {
        const pipe = decorate(new StandardSchemaValidationPipe!()) as {
          transform(value: unknown, metadata: unknown): Promise<unknown>;
        };
        const schema = {
          "~standard": { validate: (value: unknown) => ({ value }) },
        };

        await expect(
          withTrace(() => pipe.transform("a", { type: "body", schema })),
        ).resolves.toBe("a");
        expect(steps()).toEqual(["StandardSchemaValidationPipe.validate"]);
      },
    );

    it("traces what a subclass adds, and not what it inherits", async () => {
      class AppValidationPipe extends ValidationPipe {
        override async transform(value: unknown, metadata: never) {
          return super.transform(this.normalize(value), metadata);
        }

        normalize(value: unknown) {
          return value;
        }
      }
      const pipe = decorate(
        new AppValidationPipe({
          validatorPackage: { validate: () => [] } as never,
          transformerPackage: {
            plainToInstance: (_type: unknown, value: unknown) => value,
            classToPlain: (value: unknown) => value,
          } as never,
        }),
      ) as AppValidationPipe;

      await withTrace(() =>
        pipe.transform({}, { type: "body", metatype: CreateOrderDto } as never),
      );
      expect(steps()).toEqual([
        "AppValidationPipe.transform",
        "AppValidationPipe.normalize",
        "AppValidationPipe.validate",
      ]);
    });

    it("takes a subclass named after the pipe it extends for the application's", async () => {
      // `import { ValidationPipe as NestValidationPipe }` and a subclass of
      // the old name: it inherits the marker method, so it was taken for
      // Nest's own and its `toValidate` handed out unwrapped - to run on the
      // proxy, and throw on the private field it reads.
      class ValidationPipeOfTheApp extends ValidationPipe {
        readonly #exempt = new Set(["query"]);

        protected override toValidate(metadata: { type: string }) {
          return (
            !this.#exempt.has(metadata.type) &&
            super.toValidate(metadata as never)
          );
        }
      }
      Object.defineProperty(ValidationPipeOfTheApp, "name", {
        value: "ValidationPipe",
      });
      const pipe = decorate(
        new ValidationPipeOfTheApp({
          validatorPackage: { validate: () => [] },
          transformerPackage: {
            plainToInstance: (_type: unknown, value: unknown) => value,
            classToPlain: (value: unknown) => value,
          } as never,
        }),
      ) as ValidationPipe;

      await expect(
        withTrace(() =>
          pipe.transform({ total: 1 }, {
            type: "body",
            metatype: CreateOrderDto,
          } as never),
        ),
      ).resolves.toMatchObject({ total: 1 });
      // What it overrides is its own, and traced; what it inherits from
      // Nest's is not.
      expect(steps()).toEqual([
        "ValidationPipe.toValidate",
        "ValidationPipe.validate",
      ]);
    });

    it("traces everything on a pipe an application wrote, whatever its name", () => {
      // The pipe Nest's documentation has readers write, by the same name.
      class WrittenByHand {
        transform(value: string) {
          return this.toValidate(value) ? this.validate(value) : value;
        }

        toValidate(value: string) {
          return value.length > 0;
        }

        validate(value: string) {
          return value;
        }
      }
      Object.defineProperty(WrittenByHand, "name", { value: "ValidationPipe" });
      const pipe = decorate(new WrittenByHand()) as WrittenByHand;

      withTrace(() => pipe.transform("a"));
      expect(steps()).toEqual([
        "ValidationPipe.transform",
        "ValidationPipe.toValidate",
        "ValidationPipe.validate",
      ]);
    });

    it("leaves Nest's other pipes as they were", async () => {
      const pipe = decorate(new ParseIntPipe()) as ParseIntPipe;

      await withTrace(() => pipe.transform("42", { type: "param" }));
      expect(steps()).toEqual([
        "ParseIntPipe.transform",
        "ParseIntPipe.isNumeric",
      ]);
    });

    it("leaves guards and interceptors as they were", () => {
      class SessionGuard {
        canActivate() {
          return this.hasSession();
        }

        hasSession() {
          return true;
        }
      }
      class EnvelopeInterceptor {
        intercept() {
          return this.wrap();
        }

        wrap() {
          return {};
        }
      }
      const guard = decorate(new SessionGuard()) as SessionGuard;
      const interceptor = decorate(
        new EnvelopeInterceptor(),
      ) as EnvelopeInterceptor;

      withTrace(() => {
        guard.canActivate();
        interceptor.intercept();
      });
      expect(steps()).toEqual([
        "SessionGuard.canActivate",
        "SessionGuard.hasSession",
        "EnvelopeInterceptor.intercept",
        "EnvelopeInterceptor.wrap",
      ]);
    });
  });

  describe("when decorating @nestjs/config's ConfigService", () => {
    /** The shape of @nestjs/config 4's ConfigService, which the SDK doesn't depend on. */
    class ConfigService {
      private readonly cache: Record<string, unknown> = {};

      constructor(private readonly internalConfig: Record<string, unknown>) {}

      get(propertyPath: string, options?: unknown) {
        this.isGetOptionsObject(options);
        const value =
          this.getFromValidatedEnv(propertyPath) ??
          this.getFromProcessEnv(propertyPath) ??
          this.getFromInternalConfig(propertyPath);
        this.setInCacheIfDefined(propertyPath, value);
        return value;
      }

      getOrThrow(propertyPath: string) {
        const value = this.get(propertyPath);
        if (value === undefined) {
          throw new Error(`"${propertyPath}" does not exist`);
        }
        return value;
      }

      getFromValidatedEnv(_propertyPath: string): unknown {
        return undefined;
      }

      getFromProcessEnv(_propertyPath: string): unknown {
        return undefined;
      }

      getFromInternalConfig(propertyPath: string) {
        return this.internalConfig[propertyPath];
      }

      setInCacheIfDefined(propertyPath: string, value: unknown) {
        this.cache[propertyPath] = value;
      }

      isGetOptionsObject(options: unknown) {
        return typeof options === "object";
      }
    }

    const steps = () =>
      startedSteps.map((step) => `${step.className}.${step.methodName}`);

    it("traces what an application calls, not its helpers", () => {
      const config = decorate(
        new ConfigService({ port: 3000 }),
      ) as ConfigService;

      withTrace(() => {
        expect(config.get("port")).toBe(3000);
        expect(config.getOrThrow("port")).toBe(3000);
      });
      expect(steps()).toEqual([
        "ConfigService.get",
        "ConfigService.getOrThrow",
        "ConfigService.get",
      ]);
    });

    it("traces what a subclass adds", () => {
      class AppConfig extends ConfigService {
        databaseUrl() {
          return this.get("databaseUrl");
        }
      }
      const config = decorate(
        new AppConfig({ databaseUrl: "postgres://" }),
      ) as AppConfig;

      withTrace(() => config.databaseUrl());
      expect(steps()).toEqual(["AppConfig.databaseUrl", "AppConfig.get"]);
    });

    it("traces everything on an application's own ConfigService", () => {
      class OwnConfig {
        get(key: string) {
          return this.read(key);
        }

        read(key: string) {
          return key;
        }
      }
      Object.defineProperty(OwnConfig, "name", { value: "ConfigService" });
      const config = decorate(new OwnConfig()) as OwnConfig;

      withTrace(() => config.get("port"));
      expect(steps()).toEqual(["ConfigService.get", "ConfigService.read"]);
    });
  });

  describe("when decorating a class with native private members", () => {
    class SecretService {
      #prefix = "secret";

      reveal(name: string) {
        return `${this.#prefix}:${name}`;
      }

      #transform(value: string) {
        return value.toUpperCase();
      }

      shout(value: string) {
        return this.#transform(this.reveal(value));
      }
    }

    it("invokes methods that read private fields without throwing", () => {
      // A proxy receiver fails the private-brand check ("Receiver must be an
      // instance of class"), which surfaced as every exception-filter method
      // blowing up. The raw instance must be the receiver here.
      const service = decorate(new SecretService()) as SecretService;

      const result = withTrace(() => service.reveal("a"));

      expect(result).toEqual("secret:a");
      expect(startedSteps).toEqual([
        { className: "SecretService", methodName: "reveal" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "SecretService#reveal" }]);
    });

    it("invokes private methods through public ones", () => {
      const service = decorate(new SecretService()) as SecretService;

      const result = withTrace(() => service.shout("a"));

      expect(result).toEqual("SECRET:A");
    });

    it("detects private members declared on a base class", () => {
      class ExtendedSecretService extends SecretService {
        wrap(name: string) {
          return `[${this.reveal(name)}]`;
        }
      }
      const service = decorate(
        new ExtendedSecretService(),
      ) as ExtendedSecretService;

      const result = withTrace(() => service.wrap("a"));

      expect(result).toEqual("[secret:a]");
    });

    it("detects private members on a class that mixins were copied onto", () => {
      // The TypeScript handbook's `applyMixins` copies every own property of
      // the mixins' prototypes, `constructor` included, so the class's
      // prototype names the last mixin - whose source has no `#` in it.
      class Auditable {
        audit() {
          return "audited";
        }
      }
      class Account {
        #balances = new Map([["a", 100]]);

        balance(id: string) {
          return this.#balances.get(id);
        }
      }
      for (const name of Object.getOwnPropertyNames(Auditable.prototype)) {
        Object.defineProperty(
          Account.prototype,
          name,
          Object.getOwnPropertyDescriptor(Auditable.prototype, name)!,
        );
      }
      const account = decorate(new Account()) as Account & Auditable;

      expect(withTrace(() => account.balance("a"))).toEqual(100);
      expect(withTrace(() => account.audit())).toEqual("audited");
    });

    describe("compiled for a target below ES2022", () => {
      // What tsc, Babel, SWC and esbuild leave of `#owners`: the field moves
      // into a `WeakMap` keyed by the instance, and a helper checks its
      // receiver against it - the same brand check, with no `#` left.
      const brandCheckedGet = (
        receiver: object,
        state: WeakMap<object, Map<string, string>>,
      ) => {
        if (!state.has(receiver)) {
          throw new TypeError(
            "Cannot read private member from an object whose class did not declare it",
          );
        }
        return state.get(receiver)!;
      };
      const __classPrivateFieldGet = brandCheckedGet;
      const _class_private_field_get = brandCheckedGet;
      const __privateGet = brandCheckedGet;

      it.each([
        [
          "tsc",
          () => {
            const owners = new WeakMap<object, Map<string, string>>();
            return class ApiKeyStore {
              constructor() {
                owners.set(this, new Map([["k1", "alice"]]));
              }

              owner(key: string) {
                return __classPrivateFieldGet(this, owners).get(key);
              }
            };
          },
        ],
        [
          "SWC",
          () => {
            const owners = new WeakMap<object, Map<string, string>>();
            return class ApiKeyStore {
              constructor() {
                owners.set(this, new Map([["k1", "alice"]]));
              }

              owner(key: string) {
                return _class_private_field_get(this, owners).get(key);
              }
            };
          },
        ],
        [
          "esbuild",
          () => {
            const owners = new WeakMap<object, Map<string, string>>();
            return class ApiKeyStore {
              constructor() {
                owners.set(this, new Map([["k1", "alice"]]));
              }

              owner(key: string) {
                return __privateGet(this, owners).get(key);
              }
            };
          },
        ],
      ])("runs a traced method that reads one, as %s writes it", (_, make) => {
        const ApiKeyStore = make();
        const store = decorate(new ApiKeyStore()) as InstanceType<
          typeof ApiKeyStore
        >;

        expect(withTrace(() => store.owner("k1"))).toEqual("alice");
        expect(startedSteps).toEqual([
          { className: "ApiKeyStore", methodName: "owner" },
        ]);
      });

      it("keeps nested spans for a class compiled in loose mode", () => {
        // Loose mode keeps the member on the instance under a unique string
        // key, which reads through the proxy like any other.
        const _classPrivateFieldLooseBase = (receiver: object) => receiver;
        const ownersKey = "__private_0_owners";
        class ApiKeyStore {
          constructor() {
            Object.defineProperty(this, ownersKey, {
              value: new Map([["k1", "alice"]]),
            });
          }

          owner(key: string) {
            return this.lookup(key);
          }

          lookup(key: string) {
            return (
              _classPrivateFieldLooseBase(this) as unknown as Record<
                string,
                Map<string, string>
              >
            )[ownersKey].get(key);
          }
        }
        const store = decorate(new ApiKeyStore()) as ApiKeyStore;

        expect(withTrace(() => store.owner("k1"))).toEqual("alice");
        expect(startedSteps).toEqual([
          { className: "ApiKeyStore", methodName: "owner" },
          { className: "ApiKeyStore", methodName: "lookup" },
        ]);
      });
    });

    it("assigns through a setter that writes a private field", () => {
      // Without a `set` trap the setter ran with the proxy as `this`.
      class Thermostat {
        #target = 20;

        set target(value: number) {
          this.#target = value;
        }

        get target() {
          return this.#target;
        }

        read() {
          return this.#target;
        }
      }
      const thermostat = decorate(new Thermostat()) as Thermostat;

      thermostat.target = 22;
      withTrace(() => {
        thermostat.target = 23;
      });

      expect(thermostat.target).toEqual(23);
      expect(withTrace(() => thermostat.read())).toEqual(23);
    });

    describe("from node:crypto", () => {
      // Node recognises its key and certificate objects by a brand of their
      // own (`#slots in key`) wherever one is handed in as an argument, and
      // no proxy carries it: an injected key failed every `createHmac`,
      // `sign` and `jsonwebtoken` call it was given to.
      const CERTIFICATE = [
        "-----BEGIN CERTIFICATE-----",
        "MIIBhDCCASugAwIBAgIUYhOyPNcnQmLKi4iYy1m4Knpwx4EwCgYIKoZIzj0EAwIw",
        "FzEVMBMGA1UEAwwMb2JzZXJ2ZS10ZXN0MCAXDTI2MTExOTA4NDUxNloYDzIxMjYx",
        "MDI2MDg0NTE2WjAXMRUwEwYDVQQDDAxvYnNlcnZlLXRlc3QwWTATBgcqhkjOPQIB",
        "BggqhkjOPQMBBwNCAARN0Ci49a6tU2t8UNNykkSXX+PpY+imc+uPy3xz24VfexWx",
        "y81VbFhLj+Hggekpa5XvH+rwpIvtCLb3lP74xvhvo1MwUTAdBgNVHQ4EFgQUZZzK",
        "1LBE5rKSdC3SloD9Dh/6Si8wHwYDVR0jBBgwFoAUZZzK1LBE5rKSdC3SloD9Dh/6",
        "Si8wDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiAc7c4WTAQj8eFf",
        "MWcbjYUltrLHEgdzeJP65UMbUdqdKwIgIQFjzDWXWe9b62Q9umbVUkVM7bK55r3a",
        "RNvtH3y/7Lw=",
        "-----END CERTIFICATE-----",
      ].join("\n");

      it("hands a KeyObject back untouched", () => {
        const raw = createSecretKey(Buffer.from("secret"));
        const key = decorate(raw) as typeof raw;

        expect(key).toBe(raw);
        expect(
          withTrace(() => createHmac("sha256", key).update("a").digest("hex")),
        ).toHaveLength(64);
      });

      it("hands a CryptoKey back untouched", async () => {
        const raw = await subtle.importKey(
          "raw",
          Buffer.from("secret"),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );

        expect(decorate(raw)).toBe(raw);
      });

      it("hands an X509Certificate back untouched", () => {
        const raw = new X509Certificate(CERTIFICATE);
        const certificate = decorate(raw) as X509Certificate;

        expect(certificate).toBe(raw);
        expect(raw.checkIssued(certificate)).toBe(true);
      });
    });

    it("still records spans for methods on private-member classes", () => {
      const service = decorate(new SecretService()) as SecretService;

      withTrace(() => service.shout("a"));

      // Nested `this.<method>()` spans are the documented trade-off - the
      // call runs against the raw instance, so only the entry point is traced.
      expect(startedSteps).toEqual([
        { className: "SecretService", methodName: "shout" },
      ]);
    });
  });

  describe("when decorating a slot-backed built-in", () => {
    it("returns a bare Map untouched", () => {
      // `Map.prototype.has` reads `[[MapData]]` off its receiver and internal
      // slots never forward through a proxy, so a wrapped bare Map threw
      // "called on incompatible receiver" on its first use (nestjs/nest#17569).
      const cache = new Map<string, string>([["a", "1"]]);

      const decorated = decorate(cache) as Map<string, string>;

      expect(decorated).toBe(cache);
      expect(withTrace(() => decorated.has("a"))).toEqual(true);
      expect(startedSteps).toEqual([]);
    });

    it("returns other bare built-ins untouched", () => {
      const set = new Set(["a"]);
      const date = new Date(0);
      const regexp = /a/;

      expect(decorate(set)).toBe(set);
      expect(decorate(date)).toBe(date);
      expect(decorate(regexp)).toBe(regexp);
      expect(
        withTrace(() => [set.has("a"), date.getTime(), regexp.test("a")]),
      ).toEqual([true, 0, true]);
    });

    it("returns a bare Intl formatter untouched", () => {
      // `format` is an accessor that reads `[[InitializedNumberFormat]]` off
      // its receiver, and `formatToParts` a method that does: through the
      // proxy both threw "called on incompatible receiver".
      const money = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
      });
      const dates = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" });

      expect(decorate(money)).toBe(money);
      expect(decorate(dates)).toBe(dates);
      expect(startedSteps).toEqual([]);
    });

    it("invokes the natives an Intl subclass inherits without throwing", () => {
      class Prices extends Intl.NumberFormat {
        constructor() {
          super("en-US", { style: "currency", currency: "USD" });
        }

        price(cents: number) {
          return this.format(cents / 100);
        }
      }
      const prices = decorate(new Prices()) as Prices;

      expect(prices.format(12.5)).toEqual("$12.50");
      expect(withTrace(() => prices.price(1250))).toEqual("$12.50");
      expect(withTrace(() => prices.formatToParts(1)[0])).toEqual({
        type: "currency",
        value: "$",
      });
      expect(startedSteps).toEqual([
        { className: "Prices", methodName: "price" },
        { className: "Prices", methodName: "formatToParts" },
      ]);
    });

    it("invokes native methods inherited by a subclass without throwing", () => {
      class TenantCache extends Map<string, string> {
        lookup(id: string) {
          return this.has(id) ? this.get(id) : "missing";
        }
      }
      const cache = decorate(new TenantCache()) as TenantCache;
      cache.set("a", "1");

      const result = withTrace(() => cache.lookup("a"));

      expect(result).toEqual("1");
    });

    it("still records spans for user methods on a built-in subclass", () => {
      class TenantCache extends Map<string, string> {
        lookup(id: string) {
          return this.has(id);
        }
      }
      const cache = decorate(new TenantCache()) as TenantCache;

      withTrace(() => cache.lookup("a"));

      // Like private-member classes, calls run against the raw instance so
      // the inherited natives keep their internal slots - only the entry
      // point is traced, nested self-calls are the documented trade-off.
      expect(startedSteps).toEqual([
        { className: "TenantCache", methodName: "lookup" },
      ]);
    });
  });

  describe("when decorating a Node stream", () => {
    it("completes an async iteration started inside a trace", async () => {
      // Whatever feeds a stream holds the stream itself and emits on it, and
      // Node's async iterator tells its "readable" listener from its own
      // caller by comparing `this` with the stream it was made on. Made on
      // the proxy, it never woke up: `for await` over an injected request
      // body hung.
      const body = new PassThrough();
      const stream = decorate(body) as PassThrough;

      const read = withTrace(async () => {
        let text = "";
        for await (const chunk of stream) {
          text += String(chunk);
        }
        return text;
      });
      body.write("a");
      body.end("b");

      await expect(read).resolves.toEqual("ab");
    });

    it("ends the iteration with the error the stream is destroyed with", async () => {
      // A client closing its socket mid-upload. The same iterator threw
      // "callback is not a function" from the stream's own "error" event
      // instead - outside any call, so it ended the process.
      const body = new PassThrough();
      const stream = decorate(body) as PassThrough;

      const read = withTrace(async () => {
        for await (const chunk of stream) {
          void chunk;
        }
      });
      body.write("a");
      await new Promise((resolve) => setImmediate(resolve));
      body.destroy(new Error("aborted"));

      await expect(read).rejects.toThrow("aborted");
    });

    it("treats a copy of the stream classes the same", () => {
      // `readable-stream` 4 extends nothing of Node's; the state it keeps
      // gives it away.
      class Readable2 extends EventEmitter {
        readonly _readableState = { flowing: null };

        receiver() {
          return this;
        }
      }
      const raw = new Readable2();
      const stream = decorate(raw) as Readable2;

      expect(withTrace(() => stream.receiver())).toBe(raw);
    });

    it("still records spans for user methods on a stream subclass", async () => {
      class Upload extends PassThrough {
        async size() {
          let size = 0;
          for await (const chunk of this) {
            size += (chunk as Buffer).length;
          }
          return size;
        }
      }
      const upload = decorate(new Upload()) as Upload;
      upload.end("abc");

      await expect(withTrace(() => upload.size())).resolves.toEqual(3);
      // Like private-member classes, calls run against the raw instance -
      // only the entry point is traced.
      expect(startedSteps).toEqual([
        { className: "Upload", methodName: "size" },
      ]);
    });
  });

  // ioredis copies EventEmitter's prototype onto its clients', `constructor`
  // included, so a client's `constructor` is `EventEmitter`.
  describe("when decorating an ioredis client", () => {
    it.each([
      [
        "Redis",
        () => new Redis({ lazyConnect: true }),
        "Redis#getBuiltinCommands",
      ],
      [
        "Cluster",
        () =>
          new Cluster([{ host: "127.0.0.1", port: 1 }], { lazyConnect: true }),
        "Cluster#getBuiltinCommands",
      ],
    ] as const)(
      "labels a %s client's spans after it, not EventEmitter",
      (className, connect, spanId) => {
        // Never connected: lazy, and no command is sent.
        const client = connect();
        expect(client.constructor).toBe(EventEmitter);
        try {
          const decorated = decorate(client) as typeof client;

          withTrace(() => decorated.getBuiltinCommands());

          expect(startedSteps).toEqual([
            { className, methodName: "getBuiltinCommands" },
          ]);
          expect(endedSteps).toEqual([{ spanId }]);
        } finally {
          client.disconnect();
        }
      },
    );

    it("keeps the EventEmitter label on anything else whose constructor reads EventEmitter", () => {
      // Built as ioredis builds a client, but on no `Commander`.
      class Mixed {
        sendCommand() {
          return "sent";
        }
      }
      Object.defineProperty(Mixed.prototype, "constructor", {
        value: EventEmitter,
      });
      const decorated = decorate(new Mixed()) as Mixed;

      withTrace(() => decorated.sendCommand());

      expect(startedSteps).toEqual([
        { className: "EventEmitter", methodName: "sendCommand" },
      ]);
    });
  });

  describe("when the instance has no usable constructor", () => {
    const nullPrototypeProvider = () =>
      Object.assign(Object.create(null) as Record<string, unknown>, {
        greet: (name: string) => `hello ${name}`,
      }) as { greet: (name: string) => string };

    it("traces a null-prototype object under the Object label", () => {
      const provider = decorate(nullPrototypeProvider()) as {
        greet: (name: string) => string;
      };

      const result = withTrace(() => provider.greet("you"));

      expect(result).toEqual("hello you");
      expect(startedSteps).toEqual([
        { className: "Object", methodName: "greet" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "Object#greet" }]);
    });

    it("calls a null-prototype object outside a trace", () => {
      const provider = decorate(nullPrototypeProvider()) as {
        greet: (name: string) => string;
      };

      expect(provider.greet("you")).toEqual("hello you");
      expect(startedSteps).toEqual([]);
    });

    it("traces an ES module namespace", async () => {
      // A native namespace object has no prototype, so no `constructor`. A
      // `data:` module reaches Node's loader as it is. A file in the repo
      // would go through Vitest's transform and no longer be a native one.
      const moduleUrl =
        "data:text/javascript,export const greet = (name) => `hello ${name}`";
      const namespace: { greet: (name: string) => string } = await import(
        moduleUrl
      );
      expect(Object.getPrototypeOf(namespace)).toBeNull();
      const decorated = decorate(namespace) as typeof namespace;

      const result = withTrace(() => decorated.greet("you"));

      expect(result).toEqual("hello you");
      expect(startedSteps).toEqual([
        { className: "Object", methodName: "greet" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "Object#greet" }]);
    });

    it("hands plain data back untouched", () => {
      // The structured clone algorithm refuses any proxy, whatever its
      // target: `structuredClone`, `postMessage` and `workerData` threw
      // "could not be cloned" on an injected options object.
      const options = { format: "csv", columns: ["id", "total"] };
      const columns = ["id", "total"];
      const record = Object.assign(Object.create(null) as object, {
        format: "csv",
      });

      expect(decorate(options)).toBe(options);
      expect(decorate(columns)).toBe(columns);
      expect(decorate(record)).toBe(record);
      expect(structuredClone(decorate(options))).toEqual(options);
    });

    it("still traces a proxy provider that reads as data", () => {
      // nestjs-cls hands out a proxy that reads as `{}` until a request
      // resolves it; what it then forwards to is the provider.
      const service = { greet: (name: string) => `hello ${name}` };
      const resolved = new Proxy({} as typeof service, {
        get: (_target, prop) => Reflect.get(service, prop),
      });

      const decorated = decorate(resolved) as typeof service;

      expect(decorated).not.toBe(resolved);
      expect(withTrace(() => decorated.greet("you"))).toEqual("hello you");
      expect(startedSteps).toEqual([
        { className: "Object", methodName: "greet" },
      ]);
    });

    it("hands a frozen object back untouched", () => {
      // A proxy has to answer a read of a read-only, non-configurable data
      // property with the target's own value - a wrapper in its place threw
      // "'get' on proxy: property 'stringify' is a read-only and
      // non-configurable data property" - and every member of a frozen
      // object is one (bson's `EJSON`, a bundled module's exports).
      const raw = Object.freeze({
        stringify: (value: unknown) => JSON.stringify(value),
      });

      const decorated = decorate(raw) as typeof raw;

      expect(decorated).toBe(raw);
      expect(withTrace(() => decorated.stringify({ a: 1 }))).toEqual('{"a":1}');
    });

    it("hands out a read-only, non-configurable member as it is", () => {
      class Audit {
        record(entry: string) {
          return `recorded ${entry}`;
        }
      }
      const raw = new Audit();
      const format = (entry: string) => `[${entry}]`;
      Object.defineProperty(raw, "format", { value: format });
      const audit = decorate(raw) as Audit & { format: typeof format };

      expect(withTrace(() => audit.format("a"))).toEqual("[a]");
      expect(audit.format).toBe(format);
      // The class's own methods still get their spans.
      expect(withTrace(() => audit.record("a"))).toEqual("recorded a");
      expect(startedSteps).toEqual([
        { className: "Audit", methodName: "record" },
      ]);
    });

    it("uses the Object label when `constructor` is not a function", () => {
      const provider = decorate({
        constructor: { name: "Fake" },
        fn: () => "ok",
      }) as { fn: () => string };

      expect(withTrace(() => provider.fn())).toEqual("ok");
      expect(startedSteps).toEqual([{ className: "Object", methodName: "fn" }]);
    });
  });

  describe("when decorating a standalone function", () => {
    function sendEmail(to: string) {
      return `sent:${to}`;
    }

    it("records a trace step under the function label", () => {
      const wrapped = decorate(sendEmail) as typeof sendEmail;

      const result = withTrace(() => wrapped("me@example.com"));

      expect(result).toEqual("sent:me@example.com");
      expect(startedSteps).toEqual([
        { className: "Function", methodName: "sendEmail" },
      ]);
      expect(endedSteps).toEqual([{ spanId: "Function#sendEmail" }]);
    });

    it("preserves name, arity and static properties", () => {
      const decorated = Object.assign(sendEmail, { version: 2 });
      const wrapped = decorate(decorated) as typeof decorated;

      expect(wrapped.name).toEqual("sendEmail");
      expect(wrapped.length).toEqual(1);
      expect(wrapped.version).toEqual(2);
    });

    it("keeps `Proxy` out of the stack frame", () => {
      const throwing = decorate(function explode() {
        throw new Error("boom");
      }) as () => void;

      const stack = withTrace(() => {
        try {
          throwing();
          return "";
        } catch (err) {
          return (err as Error).stack ?? "";
        }
      });

      expect(stack).toContain("explode");
      expect(stack).not.toContain("Proxy");
    });

    it("propagates the caller's `this`", () => {
      const holder = {
        name: "holder",
        greet: decorate(function greet(this: { name: string }) {
          return this.name;
        }) as () => string,
      };

      expect(withTrace(() => holder.greet())).toEqual("holder");
    });

    it("leaves classes untouched", () => {
      class Repository {}

      expect(decorate(Repository)).toBe(Repository);
    });

    it("does not trace recursive calls twice", () => {
      // Recursing through the wrapper - rather than through the inner function
      // binding, which would bypass instrumentation - is what exercises the
      // re-entrancy guard.
      const countdown = decorate(function step(n: number): number {
        return n <= 0 ? 0 : countdown(n - 1);
      }) as (n: number) => number;

      withTrace(() => countdown(3));

      expect(startedSteps).toHaveLength(1);
    });
  });
});
