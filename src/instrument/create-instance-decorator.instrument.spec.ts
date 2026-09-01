import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
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
  let decorate: (instance: unknown) => unknown;

  const withTrace = <T>(fn: () => T): T =>
    als.run(new Map([[TRACE_ID_KEY, "trace-1"]]), fn);

  beforeEach(() => {
    als = new AsyncLocalStorage();
    startedSteps = [];
    endedSteps = [];

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
