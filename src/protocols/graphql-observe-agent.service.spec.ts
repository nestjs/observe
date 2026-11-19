import { ResolverDecoratorHost } from "@nestjs/graphql";
import { UnauthorizedException } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { RequestSnapshot } from "../interfaces/index.js";
import {
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { GraphQLObserveAgentService } from "./graphql-observe-agent.service.js";

const QUERY = "query Titles { titles }";

interface Ctx {
  query?: string;
}

/**
 * Drivers call the host's start hook one of two ways: `@nestjs/apollo` 14.2
 * and Mercurius await what it returns, earlier Apollo drivers hand it to the
 * end hook as it is. Both, against a real host.
 */
const drivers = {
  async awaiting(host: ResolverDecoratorHost, ctx: Ctx) {
    const state = await host.onRequestStart(ctx);
    host.onRequestEnd({ ...ctx, state });
  },
  async nonAwaiting(host: ResolverDecoratorHost, ctx: Ctx) {
    const state = host.onRequestStart(ctx);
    host.onRequestEnd({ ...ctx, state });
  },
};

function createAgent(host: ResolverDecoratorHost) {
  const als = new AsyncLocalStorage<Map<string, any>>();
  const registry = {
    addGraphQLMetadataToTrace: vi.fn(),
    internalStartTraceStep: vi.fn(() => "span-1"),
    internalEndTraceStep: vi.fn(),
  };
  const agent = new GraphQLObserveAgentService(
    als,
    { traceIdKey: "traceId", graphql: {} } as never,
    registry as never,
    {} as never,
    { shouldCapture: () => true } as never,
    { get: () => host } as never,
    { getProviders: () => [] } as never,
    { getAllMethodNames: () => [] } as never,
  );
  /** Runs `fn` as an operation inside a request the HTTP agent traces. */
  const inRequest = <T>(fn: () => T): T =>
    als.run(new Map([["traceId", "trace-1"]]), fn);
  /** The errors each span this agent opened was closed with. */
  const closedWith = () =>
    registry.internalEndTraceStep.mock.calls.map((call) => call[5]);
  return { agent, registry, inRequest, closedWith };
}

async function register(host: ResolverDecoratorHost) {
  const created = createAgent(host);
  await created.agent.onModuleInit();
  return created;
}

describe("GraphQLObserveAgentService: the request hooks it shares with the application", () => {
  let host: ResolverDecoratorHost;

  beforeEach(() => {
    host = new ResolverDecoratorHost();
  });

  it("runs a start and an end hook set before it, handing the end hook its own state", async () => {
    const seen: unknown[] = [];
    host.setOnRequestStartHook(() => ({ audited: true }));
    host.setOnRequestEndHook((ctx) => {
      seen.push(ctx.state);
    });
    const { inRequest, closedWith } = await register(host);

    await inRequest(() => drivers.awaiting(host, { query: QUERY }));

    expect(seen).toEqual([{ audited: true }]);
    expect(closedWith()).toEqual([undefined]);
  });

  it("keeps hooks set after it, and hands their getters back the application's own", async () => {
    const { inRequest, closedWith } = await register(host);
    const start = vi.fn(() => "mine");
    const end = vi.fn();
    host.setOnRequestStartHook(start);
    host.setOnRequestEndHook(end);

    expect(host.getOnRequestStartHook()).toBe(start);
    expect(host.getOnRequestEndHook()).toBe(end);

    await inRequest(() => drivers.awaiting(host, { query: QUERY }));

    expect(start).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({ state: "mine" }),
    );
    expect(closedWith()).toEqual([undefined]);
  });

  it("runs its own part once under an application hook that chains the previous one", async () => {
    const calls: string[] = [];
    host.setOnRequestStartHook(() => {
      calls.push("first");
    });
    const { inRequest, registry } = await register(host);
    const previous = host.getOnRequestStartHook();
    host.setOnRequestStartHook((ctx) => {
      previous?.(ctx);
      calls.push("second");
    });

    await inRequest(() => drivers.awaiting(host, { query: QUERY }));

    expect(calls).toEqual(["first", "second"]);
    expect(registry.internalStartTraceStep).toHaveBeenCalledOnce();
    expect(registry.internalEndTraceStep).toHaveBeenCalledOnce();
  });

  it("records a document the application's start hook refuses as failed, with its error", async () => {
    const refusal = new Error("Not a trusted document");
    host.setOnRequestStartHook(() => {
      throw refusal;
    });
    const { inRequest, closedWith } = await register(host);

    // The driver calls no end hook after a start hook that threw.
    expect(() =>
      inRequest(() => host.onRequestStart({ query: QUERY })),
    ).toThrow(refusal);
    expect(closedWith()).toEqual([refusal]);
  });

  it("returns no promise where the application's start hook returned none", async () => {
    host.setOnRequestStartHook(() => "sync");
    const { inRequest } = await register(host);

    const state = inRequest(() => host.onRequestStart({ query: QUERY }));

    expect(typeof (state as { then?: unknown }).then).toBe("undefined");
  });

  describe("an application start hook that returns a promise", () => {
    it.each(Object.keys(drivers) as (keyof typeof drivers)[])(
      "hands its end hook what it would get without the agent, on a %s driver",
      async (driver) => {
        const returned = Promise.resolve({ audited: true });
        const seen: unknown[] = [];
        host.setOnRequestStartHook(() => returned);
        host.setOnRequestEndHook((ctx) => {
          seen.push(ctx.state);
        });
        const { inRequest, closedWith } = await register(host);

        const state = inRequest(() => host.onRequestStart({ query: QUERY }));
        expect(state).toBeInstanceOf(Promise);
        if (driver === "awaiting") {
          host.onRequestEnd({ query: QUERY, state: await state });
          expect(seen).toEqual([{ audited: true }]);
        } else {
          host.onRequestEnd({ query: QUERY, state });
          expect(seen[0]).toBe(returned);
        }
        expect(closedWith()).toEqual([undefined]);
      },
    );

    it("closes the span with its rejection, which an awaiting driver sees", async () => {
      const refusal = new Error("Not a trusted document");
      host.setOnRequestStartHook(async () => {
        throw refusal;
      });
      const { inRequest, closedWith } = await register(host);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        await expect(
          inRequest(() => drivers.awaiting(host, { query: QUERY })),
        ).rejects.toBe(refusal);
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(closedWith()).toEqual([refusal]);
      expect(unhandled).toEqual([]);
    });

    it("closes the span once on a driver that calls the end hook anyway", async () => {
      const refusal = new Error("Not a trusted document");
      const returned = Promise.reject(refusal);
      // As without the agent: the application's promise is its own to handle.
      returned.catch(() => undefined);
      const seen: unknown[] = [];
      host.setOnRequestStartHook(() => returned);
      host.setOnRequestEndHook((ctx) => {
        seen.push(ctx.state);
      });
      const { inRequest, closedWith } = await register(host);

      const state = inRequest(() =>
        host.onRequestStart({ query: QUERY }),
      ) as Promise<unknown>;
      await expect(state).rejects.toBe(refusal);
      host.onRequestEnd({ query: QUERY, state });

      expect(seen[0]).toBe(returned);
      expect(closedWith()).toEqual([refusal]);
    });

    it("adds no unhandled rejection of its own on a driver that does not await it", async () => {
      // The application handles its own promise, as it may without the agent;
      // the driver only hands the start hook's result to the end hook.
      const returned = Promise.reject(new Error("Not a trusted document"));
      returned.catch(() => undefined);
      host.setOnRequestStartHook(() => returned);
      const { inRequest, closedWith } = await register(host);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        await inRequest(() => drivers.nonAwaiting(host, { query: QUERY }));
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(unhandled).toEqual([]);
      expect(closedWith()).toHaveLength(1);
    });
  });

  it("replaces the part a first agent set on the same host instead of nesting it", async () => {
    const application = vi.fn();
    host.setOnRequestStartHook(application);
    const first = await register(host);
    const second = await register(host);

    await second.inRequest(() => drivers.awaiting(host, { query: QUERY }));

    expect(application).toHaveBeenCalledOnce();
    expect(first.registry.internalStartTraceStep).not.toHaveBeenCalled();
    expect(second.registry.internalStartTraceStep).toHaveBeenCalledOnce();
    expect(host.getOnRequestStartHook()).toBe(application);
  });
});

/**
 * Against a real registry: operations inside a request the HTTP agent
 * already traces, under the registry key the HTTP agent gave it.
 */
function createTracingAgent(graphql: Record<string, unknown> = {}) {
  const als = new AsyncLocalStorage<Map<string, any>>();
  const registry = new OperationTraceRegistry(als as never, false);
  const agent = new GraphQLObserveAgentService(
    als,
    { traceIdKey: "traceId", graphql } as never,
    registry,
    {} as never,
    { shouldCapture: () => true } as never,
    { get: () => undefined } as never,
    { getProviders: () => [] } as never,
    { getAllMethodNames: () => [] } as never,
  );
  /** A request the HTTP agent opened a trace for, with nothing named yet. */
  const openRequest = (key: string) => {
    registry.startTrace(
      key,
      {
        protocol: "http",
        tags: {},
        attributes: { method: "POST", originalUrl: "/graphql" },
      },
      `public-${key}`,
    );
    return new Map<string, unknown>([
      ["traceId", `public-${key}`],
      [TRACE_REGISTRY_KEY, key],
    ]);
  };
  const start = (store: Map<string, unknown>, query: string) =>
    als.run(store, () => agent.onRequestStart({ query }));
  const end = (
    store: Map<string, unknown>,
    state: unknown,
    errors?: Parameters<typeof agent.onRequestEnd>[0]["errors"],
  ) => als.run(store, () => agent.onRequestEnd({ state, errors }));
  return { als, agent, registry, openRequest, start, end };
}

describe("GraphQLObserveAgentService: graphql.ignore", () => {
  const ignoreHealth = {
    ignore: (info: { fieldName: string }) => info.fieldName === "health",
  };

  it("sets the attributes of an ignored operation all the same", () => {
    // `ignore` is asked about the field that leads the document, and the
    // resolvers of the fields behind it run whether or not it matches. What
    // they read must not depend on the order a client wrote the fields in.
    const { openRequest, start } = createTracingAgent({
      ...ignoreHealth,
      setAttributes: (info: { fieldName: string }) => ({
        tenant: `led by ${info.fieldName}`,
      }),
    });
    const ignored = openRequest("r1");
    const recorded = openRequest("r2");

    expect(start(ignored, "{ health tenant }")).toBeUndefined();
    start(recorded, "{ tenant health }");

    expect(ignored.get("tenant")).toBe("led by health");
    expect(recorded.get("tenant")).toBe("led by tenant");
  });

  it("drops the request's trace, so nothing the operation reaches is recorded", () => {
    const { registry, openRequest, start } = createTracingAgent(ignoreHealth);
    const store = openRequest("r1");

    expect(start(store, "{ health }")).toBeUndefined();

    expect(registry.hasTrace("r1")).toBe(false);
    // As on a request `http.ignore` excluded: a provider called now opens
    // no span.
    expect(
      registry.internalStartTraceStep(
        "r1",
        "HealthService",
        "check",
        undefined,
      ),
    ).toBeUndefined();
  });

  it("keeps a trace something named before the ignored operation started", () => {
    const { registry, openRequest, start } = createTracingAgent(ignoreHealth);
    // A route handler that runs the operation in-process.
    const routed = openRequest("r1");
    registry.addRouteMetadataToTrace("r1", "GET" as never, "/status");
    // A batch a recorded operation leads.
    const batched = openRequest("r2");
    start(batched, "{ orders }");

    expect(start(routed, "{ health }")).toBeUndefined();
    expect(start(batched, "{ health }")).toBeUndefined();

    expect(registry.hasTrace("r1")).toBe(true);
    expect(registry.hasTrace("r2")).toBe(true);
  });
});

/**
 * Apollo runs the operations of a batched HTTP request at once, in the one
 * async store that request has, and ends them in any order.
 */
describe("GraphQLObserveAgentService: a batched request", () => {
  /** What graphql hands the end hook for a resolver that threw `error`. */
  const failedWith = (error: Error) => [
    { message: error.message, path: ["field"], originalError: error },
  ];

  /** Ends the request as the HTTP agent does, with graphql's 200. */
  const shipped = async (registry: OperationTraceRegistry, key: string) => {
    registry.endTrace(key, { statusCode: 200 });
    return (await registry.pluckSnapshot(key)) as RequestSnapshot;
  };

  it("records its operations side by side, each a root span", async () => {
    const { registry, openRequest, start, end } = createTracingAgent();
    const store = openRequest("r1");

    const states = ["{ first }", "{ second }", "{ third }"].map((query) =>
      start(store, query),
    );
    // Only the last one fails. Nested under the others, it was on no root
    // span, and the request was reported as a success.
    end(store, states[0]);
    end(store, states[1]);
    end(store, states[2], failedWith(new Error("deliberate")));
    const snapshot = await shipped(registry, "r1");

    expect(snapshot.traces.map((span) => span.methodKey)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(snapshot.traces.every((span) => !span.children?.length)).toBe(true);
    expect(snapshot.attributes?.statusCode).toBe(500);
    expect(snapshot.error?.message).toBe("deliberate");
  });

  it.each([
    ["the order they started in", [0, 1]],
    ["the other order", [1, 0]],
  ])(
    "reports the status of the failure it reports the error of, ended in %s",
    async (_order, endOrder) => {
      const { registry, openRequest, start, end } = createTracingAgent();
      const store = openRequest("r1");
      const failures = [
        new Error("the database is down"),
        new UnauthorizedException("sign in first"),
      ];

      const states = ["{ first }", "{ second }"].map((query) =>
        start(store, query),
      );
      for (const index of endOrder) {
        end(store, states[index], failedWith(failures[index]));
      }
      const snapshot = await shipped(registry, "r1");

      expect(snapshot.error?.message).toBe("the database is down");
      expect(snapshot.attributes?.statusCode).toBe(500);
    },
  );

  it.each([
    ["the order they started in", [0, 1]],
    ["the other order", [1, 0]],
  ])(
    "leaves the store naming an operation still open, ended in %s",
    (_order, endOrder) => {
      const { openRequest, start, end } = createTracingAgent();
      const store = openRequest("r1");
      // Whatever named the request before the batch: a middleware's span.
      store.set(CALLER_METADATA_KEY, "outer");

      const states = ["{ first }", "{ second }"].map(
        (query) => start(store, query) as unknown as { spanId: string },
      );
      end(store, states[endOrder[0]]);

      // The one still running reaches a provider after the other ended, and
      // its call belongs under it - not at the root, nor under an ended span.
      expect(store.get(CALLER_METADATA_KEY)).toBe(states[endOrder[1]].spanId);

      end(store, states[endOrder[1]]);
      expect(store.get(CALLER_METADATA_KEY)).toBe("outer");
    },
  );

  it("nests an operation started inside a span's own store", async () => {
    // A provider that runs an operation in-process: its span's store is a
    // copy of the request's, and the operation really is its callee.
    const { registry, openRequest, start, end } = createTracingAgent();
    const store = openRequest("r1");
    const outer = start(store, "{ report }") as unknown as { spanId: string };
    const callee = new Map(store);

    const inner = start(callee, "{ orders }");
    end(callee, inner);
    end(store, outer);
    const snapshot = await shipped(registry, "r1");

    expect(snapshot.traces).toHaveLength(1);
    expect(snapshot.traces[0].children?.map((span) => span.methodKey)).toEqual([
      "orders",
    ]);
    expect(callee.get(CALLER_METADATA_KEY)).toBe(outer.spanId);
  });
});
