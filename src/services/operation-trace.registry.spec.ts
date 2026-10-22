import {
  BadRequestException,
  InternalServerErrorException,
  IntrinsicException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";
import {
  setActiveSliceRecorder,
  SpanSliceRecorder,
} from "../profiling/span-slice-recorder.js";
import { SPAN_COLLAPSED_TAG } from "./collapse-repeated-spans.util.js";
import { OperationTraceRegistry } from "./operation-trace.registry.js";
import { resolveSkipSpans } from "./skip-spans.util.js";

/**
 * The registry holds one in-flight snapshot per trace and assembles the span
 * tree underneath it. Two properties matter most and neither is visible from a
 * type: a span's id doubles as the caller id it is registered under (which is
 * what lets a log line resolve back to the span it was written inside), and a
 * snapshot is only shipped once every span it opened has closed.
 */
describe("OperationTraceRegistry", () => {
  let als: AsyncLocalStorage<Map<string, unknown>>;
  let registry: OperationTraceRegistry;

  beforeEach(() => {
    als = new AsyncLocalStorage();
    // Source context reads files off disk to build code frames; off here so the
    // tests describe the registry rather than the filesystem.
    registry = new OperationTraceRegistry(als as never, false);
  });

  const startRequest = (traceId: string) =>
    registry.startTrace(traceId, {
      operationId: "GET /orders",
      protocol: "http",
      attributes: { method: "GET", originalUrl: "/orders" },
      tags: {},
    });

  describe("abandoning a trace", () => {
    it("frees an abandoned trace entirely - spans and snapshot both", async () => {
      startRequest("t-abort");
      const spanId = registry.internalStartTraceStep(
        "t-abort",
        "Svc",
        "handle",
        undefined,
      );

      registry.abandonTrace("t-abort");

      // Both maps must be cleared: the snapshot is what pluck reads, and the
      // span map is where an aborted request's tree would otherwise keep
      // accumulating references for the life of the process.
      expect(registry.getActiveSpan("t-abort", spanId)).toBeUndefined();
      await expect(registry.pluckSnapshot("t-abort")).resolves.toBeUndefined();
    });

    it("is a no-op for a trace that was never started", () => {
      expect(() => registry.abandonTrace("never-started")).not.toThrow();
    });
  });

  describe("trace lifecycle", () => {
    it("returns nothing for a trace that was never started", async () => {
      await expect(
        registry.pluckSnapshot("no-such-trace"),
      ).resolves.toBeUndefined();
    });

    it("plucks a completed snapshot exactly once", async () => {
      startRequest("t1");
      const spanId = registry.internalStartTraceStep(
        "t1",
        "Svc",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep("t1", spanId, "Svc", "handle", spanId);
      registry.endTrace("t1");

      const snapshot = await registry.pluckSnapshot("t1");
      expect(snapshot).toBeDefined();

      // Plucking removes it: a snapshot shipped twice is a duplicate row.
      await expect(registry.pluckSnapshot("t1")).resolves.toBeUndefined();
    });

    it("discards a trace that recorded no spans", async () => {
      startRequest("t2");
      registry.endTrace("t2");

      // No spans means nothing was instrumented, so there is nothing worth
      // shipping.
      await expect(registry.pluckSnapshot("t2")).resolves.toBeUndefined();
    });

    it("replaces a trace started twice under the same id", async () => {
      startRequest("t3");
      const first = registry.internalStartTraceStep(
        "t3",
        "Svc",
        "first",
        undefined,
      );
      registry.internalEndTraceStep("t3", first, "Svc", "first", first);

      startRequest("t3");
      const second = registry.internalStartTraceStep(
        "t3",
        "Svc",
        "second",
        undefined,
      );
      registry.internalEndTraceStep("t3", second, "Svc", "second", second);
      registry.endTrace("t3");

      const snapshot = await registry.pluckSnapshot("t3");
      expect(JSON.stringify(snapshot)).toContain("second");
      expect(JSON.stringify(snapshot)).not.toContain("first");
    });

    it("ignores an end for a trace that does not exist", () => {
      expect(() => registry.endTrace("never-started")).not.toThrow();
    });

    it("records the duration on the snapshot", async () => {
      startRequest("t4");
      const spanId = registry.internalStartTraceStep(
        "t4",
        "Svc",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep("t4", spanId, "Svc", "handle", spanId);
      registry.endTrace("t4");

      const snapshot = await registry.pluckSnapshot("t4");
      expect(snapshot!.duration).toEqual(expect.any(Number));
      // `startTimestamp` is scratch state and must not travel on the wire.
      expect(snapshot).not.toHaveProperty("startTimestamp");
      expect(snapshot).not.toHaveProperty("refsCounter");
      expect(snapshot).not.toHaveProperty("refsMarkedAsComplete");
    });
  });

  describe("span tree", () => {
    it("puts a span with no caller at the root", async () => {
      startRequest("t5");
      const spanId = registry.internalStartTraceStep(
        "t5",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep("t5", spanId, "Svc", "root", spanId);
      registry.endTrace("t5");

      const snapshot = await registry.pluckSnapshot("t5");
      expect(snapshot!.traces).toHaveLength(1);
      expect(snapshot!.traces[0]).toMatchObject({ methodKey: "root" });
    });

    it("nests a span under its caller", async () => {
      startRequest("t6");
      const parent = registry.internalStartTraceStep(
        "t6",
        "Svc",
        "parent",
        undefined,
      );
      const child = registry.internalStartTraceStep(
        "t6",
        "Repo",
        "child",
        parent,
      );
      registry.internalEndTraceStep("t6", child, "Repo", "child", child);
      registry.internalEndTraceStep("t6", parent, "Svc", "parent", parent);
      registry.endTrace("t6");

      const snapshot = await registry.pluckSnapshot("t6");
      const root = snapshot!.traces[0] as {
        children?: Array<{ methodKey: string }>;
      };
      expect(root.children?.map((node) => node.methodKey)).toEqual(["child"]);
    });

    it("puts a span whose caller already completed at the root instead of throwing", async () => {
      startRequest("t6b");
      const caller = registry.internalStartTraceStep(
        "t6b",
        "Interceptor",
        "intercept",
        undefined,
      );
      // An interceptor's `intercept()` returns its Observable synchronously, so
      // its span closes - and, having no children yet, loses its `children`
      // array - before the handler that Nest bound to its async context runs.
      registry.internalEndTraceStep(
        "t6b",
        caller,
        "Interceptor",
        "intercept",
        caller,
      );

      let late: string | undefined;
      expect(() => {
        late = registry.internalStartTraceStep("t6b", "Ctrl", "handle", caller);
      }).not.toThrow();
      registry.internalEndTraceStep("t6b", late, "Ctrl", "handle", late);
      registry.endTrace("t6b");

      const snapshot = await registry.pluckSnapshot("t6b");
      expect(snapshot!.traces.map((node) => node.methodKey)).toEqual([
        "intercept",
        "handle",
      ]);
    });

    it("puts a manual span whose caller already completed at the root instead of throwing", async () => {
      startRequest("t6c");
      const caller = registry.internalStartTraceStep(
        "t6c",
        "Interceptor",
        "intercept",
        undefined,
      );
      // Same shape as the auto-span case above, reached through the public
      // TracerService API instead: the manual span opens under a caller whose
      // `children` array is already gone.
      registry.internalEndTraceStep(
        "t6c",
        caller,
        "Interceptor",
        "intercept",
        caller,
      );

      await expect(
        registry.createManualSpan("t6c", caller, "manual-step", () => "ok"),
      ).resolves.toBe("ok");
      registry.endTrace("t6c");

      const snapshot = await registry.pluckSnapshot("t6c");
      expect(
        snapshot!.traces.map((node) =>
          "name" in node ? node.name : node.methodKey,
        ),
      ).toEqual(["intercept", "manual-step"]);
    });

    it("uses the span id as the caller id it registers under", async () => {
      startRequest("t7");
      const spanId = registry.internalStartTraceStep(
        "t7",
        "Svc",
        "root",
        undefined,
      );

      // This identity is what lets a forwarded log line name its span: the
      // forwarder reads the caller id out of the async store and expects it to
      // be the span id.
      expect(registry.getActiveSpan("t7", spanId)?.spanId).toBe(spanId);
    });

    it("strips scratch fields from a completed span", async () => {
      startRequest("t8");
      const spanId = registry.internalStartTraceStep(
        "t8",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep("t8", spanId, "Svc", "root", spanId);
      registry.endTrace("t8");

      const snapshot = await registry.pluckSnapshot("t8");
      const root = snapshot!.traces[0] as unknown as Record<string, unknown>;

      expect(root).not.toHaveProperty("type");
      expect(root).not.toHaveProperty("startTime");
      // A parent back-reference would make the tree cyclic and unserialisable.
      expect(root).not.toHaveProperty("parent");
      expect(root.duration).toEqual(expect.any(Number));
    });

    it("records how far into the trace each span started", async () => {
      startRequest("t9");
      const spanId = registry.internalStartTraceStep(
        "t9",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep("t9", spanId, "Svc", "root", spanId);
      registry.endTrace("t9");

      const snapshot = await registry.pluckSnapshot("t9");
      const root = snapshot!.traces[0] as { startOffset?: number };

      // Captured when the span opens, because `startTimestamp` is gone once the
      // trace ends.
      expect(root.startOffset).toEqual(expect.any(Number));
      expect(root.startOffset).toBeGreaterThanOrEqual(0);
    });

    it("ignores a span started against an unknown trace", () => {
      expect(
        registry.internalStartTraceStep("unknown", "Svc", "m", undefined),
      ).toBeUndefined();
    });

    it("ignores an end for a span that was never opened", () => {
      startRequest("t10");
      registry.internalStartTraceStep("t10", "Svc", "root", undefined);

      // Happens when an async call is not awaited and the outer span closes
      // first; it must warn rather than throw.
      expect(() =>
        registry.internalEndTraceStep("t10", "ghost", "Svc", "ghost", "ghost"),
      ).not.toThrow();
    });
  });

  describe("errors", () => {
    it("attaches an error payload to the root span", async () => {
      startRequest("e1");
      const spanId = registry.internalStartTraceStep(
        "e1",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep(
        "e1",
        spanId,
        "Svc",
        "root",
        spanId,
        new Error("boom"),
      );
      registry.endTrace("e1");

      const snapshot = await registry.pluckSnapshot("e1");
      const root = snapshot!.traces[0] as {
        error?: { message: string; cls?: string };
      };

      expect(root.error).toMatchObject({ message: "boom", cls: "Error" });
    });

    it("redacts secrets out of the message and stack by default", async () => {
      startRequest("e-redact");
      const spanId = registry.internalStartTraceStep(
        "e-redact",
        "Svc",
        "root",
        undefined,
      );
      const error = new Error(
        "connect failed: postgres://app:password=hunter2@db/orders",
      );
      error.stack = `Error: ${error.message}\n    at Svc.root (/app/svc.ts:1:1)\n    at token=eyJhbGciOi.eyJzdWIiOi.sig`;
      registry.internalEndTraceStep(
        "e-redact",
        spanId,
        "Svc",
        "root",
        spanId,
        error,
      );
      registry.endTrace("e-redact");

      const snapshot = await registry.pluckSnapshot("e-redact");
      const root = snapshot!.traces[0] as {
        error?: { message: string; stack?: string };
      };

      expect(root.error!.message).toBe(
        "connect failed: postgres://app:password=[REDACTED]",
      );
      expect(root.error!.stack).not.toContain("hunter2");
      expect(root.error!.stack).not.toContain("eyJhbGciOi");
      // The frames themselves survive: they are what the stack is for.
      expect(root.error!.stack).toContain("at Svc.root (/app/svc.ts:1:1)");
    });

    it("ships the error verbatim once redaction is switched off", async () => {
      registry.configureRedaction(null);
      startRequest("e-raw");
      const spanId = registry.internalStartTraceStep(
        "e-raw",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep(
        "e-raw",
        spanId,
        "Svc",
        "root",
        spanId,
        new Error("password=hunter2"),
      );
      registry.endTrace("e-raw");

      const snapshot = await registry.pluckSnapshot("e-raw");
      const root = snapshot!.traces[0] as { error?: { message: string } };

      expect(root.error!.message).toBe("password=hunter2");
    });

    it("marks a nested span as failed without repeating the payload", async () => {
      startRequest("e2");
      const parent = registry.internalStartTraceStep(
        "e2",
        "Svc",
        "parent",
        undefined,
      );
      const child = registry.internalStartTraceStep(
        "e2",
        "Repo",
        "child",
        parent,
      );
      registry.internalEndTraceStep(
        "e2",
        child,
        "Repo",
        "child",
        child,
        new Error("inner"),
      );
      registry.internalEndTraceStep("e2", parent, "Svc", "parent", parent);
      registry.endTrace("e2");

      const snapshot = await registry.pluckSnapshot("e2");
      const root = snapshot!.traces[0] as {
        children?: Array<{ error?: unknown }>;
      };

      // The full payload lives on the root; a nested failure is a flag, keeping
      // one stack per snapshot rather than one per span.
      expect(root.children?.[0].error).toBe(true);
    });

    it("promotes a root span error onto the snapshot", async () => {
      startRequest("e3");
      const spanId = registry.internalStartTraceStep(
        "e3",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep(
        "e3",
        spanId,
        "Svc",
        "root",
        spanId,
        new Error("surfaced"),
      );
      registry.endTrace("e3");

      const snapshot = await registry.pluckSnapshot("e3");
      expect(snapshot!.error).toMatchObject({ message: "surfaced" });
    });

    it("captures an error against the active span with tags", async () => {
      startRequest("e4");
      const spanId = registry.internalStartTraceStep(
        "e4",
        "Svc",
        "root",
        undefined,
      );

      registry.captureError("e4", spanId, new Error("captured"), {
        orderId: "o-1",
      });
      registry.internalEndTraceStep("e4", spanId, "Svc", "root", spanId);
      registry.endTrace("e4");

      const snapshot = await registry.pluckSnapshot("e4");
      const root = snapshot!.traces[0] as {
        error?: { message: string };
        tags?: Record<string, unknown>;
      };
      expect(root.error).toMatchObject({ message: "captured" });
      expect(root.tags).toMatchObject({ orderId: "o-1" });
    });

    it("ignores a capture against an unknown trace", () => {
      expect(() =>
        registry.captureError("nope", "span", new Error("x"), {}),
      ).not.toThrow();
    });

    it("records a thrown non-Error", async () => {
      startRequest("e5");
      const spanId = registry.internalStartTraceStep(
        "e5",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep(
        "e5",
        spanId,
        "Svc",
        "root",
        spanId,
        "just a string",
      );
      registry.endTrace("e5");

      const snapshot = await registry.pluckSnapshot("e5");
      const root = snapshot!.traces[0] as { error?: unknown };
      // A string throw carries no stack, so the root records only that it failed.
      expect(root.error).toBe(true);
    });
  });

  describe("route metadata", () => {
    it("records the matched route as the operation id", async () => {
      startRequest("r1");
      const spanId = registry.internalStartTraceStep(
        "r1",
        "Svc",
        "root",
        undefined,
      );
      registry.addRouteMetadataToTrace("r1", 0, "/orders/:id");
      registry.internalEndTraceStep("r1", spanId, "Svc", "root", spanId);
      registry.endTrace("r1");

      const snapshot = (await registry.pluckSnapshot("r1")) as RequestSnapshot;
      // The parameterised path, not the concrete URL - otherwise every id is a
      // separate operation.
      expect(snapshot.operationId).toBe("/orders/:id");
    });

    it("ignores metadata for an unknown trace", () => {
      expect(() =>
        registry.addRouteMetadataToTrace("nope", 0, "/x"),
      ).not.toThrow();
    });
  });

  describe("setOperationId", () => {
    it("replaces the route name without changing request metadata or spans", async () => {
      registry.startTrace("custom", {
        protocol: "http",
        attributes: { method: "POST", originalUrl: "/rpc" },
        tags: { tenant: "acme" },
      });
      registry.addRouteMetadataToTrace("custom", 1, "/rpc");
      const spanId = registry.internalStartTraceStep(
        "custom",
        "RpcController",
        "handle",
        undefined,
      );

      registry.setOperationId("custom", "/rpc/orders.get");
      registry.setOperationId("custom", "/rpc/orders.list");
      registry.internalEndTraceStep(
        "custom",
        spanId,
        "RpcController",
        "handle",
        spanId,
      );
      registry.endTrace("custom", { statusCode: 201, userId: "u-1" });

      const snapshot = await registry.pluckSnapshot("custom");
      expect(snapshot).toMatchObject({
        traceId: "custom",
        protocol: "http",
        operationId: "/rpc/orders.list",
        attributes: {
          method: "POST",
          originalUrl: "/rpc",
          statusCode: 201,
          defaultOperationId: "/rpc",
        },
        tags: { tenant: "acme" },
        userId: "u-1",
        traces: [{ spanId, className: "RpcController", methodKey: "handle" }],
      });
      expect(snapshot!.traces).toHaveLength(1);
    });

    /** Runs the handler's span, then ends the request and plucks it. */
    const finishRequest = async (traceId: string) => {
      const spanId = registry.internalStartTraceStep(
        traceId,
        "RpcController",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep(
        traceId,
        spanId,
        "RpcController",
        "handle",
        spanId,
      );
      registry.endTrace(traceId, { statusCode: 201 });
      return (await registry.pluckSnapshot(traceId)) as RequestSnapshot;
    };

    it("keeps a name set before the route is known, as middleware sets it", async () => {
      // Nest fires the route hook after middleware has run, and the hook names
      // the trace after its route: the name set first must still win.
      registry.startTrace("early", {
        protocol: "http",
        attributes: { method: "POST", originalUrl: "/rpc" },
      });
      registry.setOperationId("early", "/rpc/orders.list");
      registry.addRouteMetadataToTrace("early", 1, "/rpc");

      expect(await finishRequest("early")).toMatchObject({
        operationId: "/rpc/orders.list",
        attributes: { defaultOperationId: "/rpc" },
      });
    });

    it("keeps the path a request that matched no route is grouped under", async () => {
      registry.startTrace("unrouted", {
        protocol: "http",
        attributes: { method: "POST", originalUrl: "/rpc?trace=1" },
      });
      registry.setOperationId("unrouted", "/rpc/orders.list");

      expect(await finishRequest("unrouted")).toMatchObject({
        operationId: "/rpc/orders.list",
        attributes: { defaultOperationId: "/rpc" },
      });
    });

    it("records no rename for the name a request already had", async () => {
      registry.startTrace("same", {
        protocol: "http",
        attributes: { method: "POST", originalUrl: "/rpc" },
      });
      registry.addRouteMetadataToTrace("same", 1, "/rpc");
      registry.setOperationId("same", "/rpc");

      const snapshot = await finishRequest("same");
      expect(snapshot.operationId).toBe("/rpc");
      expect(snapshot.attributes).not.toHaveProperty("defaultOperationId");
    });

    it("has skipSpans judge the request by its new name", async () => {
      registry.configureSkipSpans(
        ({ operationId }) => operationId === "/rpc/health.check",
      );
      registry.startTrace("skipped", {
        protocol: "http",
        attributes: { method: "POST", originalUrl: "/rpc" },
      });
      registry.addRouteMetadataToTrace("skipped", 1, "/rpc");
      registry.setOperationId("skipped", "/rpc/health.check");

      expect((await finishRequest("skipped")).traces).toEqual([]);
    });

    it("overrides a GraphQL name and survives subsequent root field metadata", async () => {
      registry.startTrace("graphql", { protocol: "graphql", tags: {} });
      registry.addGraphQLMetadataToTrace("graphql", {
        operationId: "Query.orders",
      });
      const spanId = registry.internalStartTraceStep(
        "graphql",
        "OrdersResolver",
        "orders",
        undefined,
      );

      registry.setOperationId("graphql", "OrdersOverview");
      registry.addGraphQLMetadataToTrace("graphql", {
        operationId: "Query.customers",
      });
      registry.internalEndTraceStep(
        "graphql",
        spanId,
        "OrdersResolver",
        "orders",
        spanId,
      );
      registry.endTrace("graphql");

      expect(await registry.pluckSnapshot("graphql")).toMatchObject({
        operationId: "OrdersOverview",
        attributes: { defaultOperationId: "Query.orders" },
      });
    });

    it("does not create a snapshot for an unknown or unsampled trace", async () => {
      expect(() =>
        registry.setOperationId("unsampled", "/rpc/orders.list"),
      ).not.toThrow();
      expect(registry.hasTrace("unsampled")).toBe(false);
      await expect(
        registry.pluckSnapshot("unsampled"),
      ).resolves.toBeUndefined();
    });

    it("leaves queue job names and metadata unchanged", async () => {
      registry.startTrace("job", {
        id: "job-1",
        traceId: "job",
        name: "sendEmail",
        queueName: "mail",
        traces: [],
      });
      const spanId = registry.internalStartTraceStep(
        "job",
        "MailProcessor",
        "process",
        undefined,
      );

      registry.setOperationId("job", "/rpc/orders.list");
      registry.internalEndTraceStep(
        "job",
        spanId,
        "MailProcessor",
        "process",
        spanId,
      );
      registry.endTrace("job", { status: "completed" });

      const snapshot = await registry.pluckSnapshot("job");
      expect(snapshot).toMatchObject({
        id: "job-1",
        name: "sendEmail",
        queueName: "mail",
        status: "completed",
      });
      expect(snapshot).not.toHaveProperty("operationId");
    });
  });

  describe("request outcome", () => {
    it("records the status code and user", async () => {
      startRequest("o1");
      const spanId = registry.internalStartTraceStep(
        "o1",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep("o1", spanId, "Svc", "root", spanId);
      registry.endTrace("o1", { statusCode: 201, userId: "u-9" });

      const snapshot = (await registry.pluckSnapshot("o1")) as RequestSnapshot;
      expect(snapshot.attributes?.statusCode).toBe(201);
      expect(snapshot.userId).toBe("u-9");
    });

    it("coerces a numeric user id to a string", async () => {
      startRequest("o2");
      const spanId = registry.internalStartTraceStep(
        "o2",
        "Svc",
        "root",
        undefined,
      );
      registry.internalEndTraceStep("o2", spanId, "Svc", "root", spanId);
      registry.endTrace("o2", { userId: 42 as never });

      const snapshot = (await registry.pluckSnapshot("o2")) as RequestSnapshot;
      // The column is text; a number here would be a type error at insert.
      expect(snapshot.userId).toBe("42");
    });
  });

  /**
   * RPC and gRPC have no response object to read a status code off, and the
   * backend buckets errors by status code alone - 5xx unhandled, 4xx handled.
   * A failing message pattern that reported no status code at all would show up
   * as zero errors of either kind, which is the bug these cases pin down.
   */
  describe("errors on transports without a status code", () => {
    const startRpc = (traceId: string) =>
      registry.startTrace(traceId, {
        operationId: "orders.find",
        protocol: "TCP",
        tags: {},
      });

    const failWith = (traceId: string, error: unknown) => {
      const spanId = registry.internalStartTraceStep(
        traceId,
        "Svc",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep(
        traceId,
        spanId,
        "Svc",
        "handle",
        spanId,
        error as never,
      );
      registry.endTrace(traceId, { userId: "u-1" });
      return registry.pluckSnapshot(traceId) as Promise<RequestSnapshot>;
    };

    it("reports 500 for a non-intrinsic error", async () => {
      startRpc("u1");
      const snapshot = await failWith("u1", new Error("deliberate"));

      // The snapshot carries no `attributes` at all on this path, so the 500
      // has to create them rather than assume they exist.
      expect(snapshot.attributes?.statusCode).toBe(500);
    });

    it("reports an intrinsic error in the handled range", async () => {
      startRpc("u2");
      const snapshot = await failWith("u2", new BadRequestException("nope"));

      // `HttpException` extends `IntrinsicException`: the handler raised this
      // deliberately, and it carries a 4xx of its own worth keeping.
      expect(snapshot.attributes?.statusCode).toBe(400);
    });

    it("keeps an intrinsic error out of the unhandled bucket", async () => {
      startRpc("u2b");
      const snapshot = await failWith(
        "u2b",
        new InternalServerErrorException("nope"),
      );

      // Its own code is 5xx, which the backend would count as unhandled - but
      // the handler chose to throw it, so it belongs in the handled bucket.
      expect(snapshot.attributes?.statusCode).toBe(400);
    });

    it("reports a non-HttpException intrinsic error as handled", async () => {
      class DomainException extends IntrinsicException {}

      startRpc("u2c");
      const snapshot = await failWith("u2c", new DomainException("nope"));

      // No `getStatus` to read: intrinsic is the whole signal.
      expect(snapshot.attributes?.statusCode).toBe(400);
    });

    it("ignores an error thrown below the root span", async () => {
      startRpc("u3");
      const rootId = registry.internalStartTraceStep(
        "u3",
        "Svc",
        "handle",
        undefined,
      );
      const childId = registry.internalStartTraceStep(
        "u3",
        "Repo",
        "find",
        rootId,
      );
      registry.internalEndTraceStep(
        "u3",
        childId,
        "Repo",
        "find",
        childId,
        new Error("caught upstream"),
      );
      registry.internalEndTraceStep("u3", rootId, "Svc", "handle", rootId);
      registry.endTrace("u3");

      const snapshot = (await registry.pluckSnapshot("u3")) as RequestSnapshot;
      // The caller swallowed it and returned normally - the call did not fail.
      expect(snapshot.attributes?.statusCode).toBeUndefined();
    });

    it("does not override a status code the transport supplied", async () => {
      startRequest("u4");
      const spanId = registry.internalStartTraceStep(
        "u4",
        "Svc",
        "handle",
        undefined,
      );
      registry.internalEndTraceStep(
        "u4",
        spanId,
        "Svc",
        "handle",
        spanId,
        new Error("deliberate"),
      );
      registry.endTrace("u4", { statusCode: 503 });

      const snapshot = (await registry.pluckSnapshot("u4")) as RequestSnapshot;
      // HTTP reads the real response; the fallback must not clobber it.
      expect(snapshot.attributes?.statusCode).toBe(503);
    });

    it("outranks a success status code the transport supplied", async () => {
      // GraphQL is why this rule exists: a resolver that threw is still
      // answered with a 200 and its error reported in the body, so trusting the
      // transport would give a broken operation a clean bill of health.
      startRequest("u4b");
      const spanId = registry.internalStartTraceStep(
        "u4b",
        "Query",
        "brokenOrder",
        undefined,
      );
      registry.internalEndTraceStep(
        "u4b",
        spanId,
        "Query",
        "brokenOrder",
        spanId,
        new Error("deliberate"),
      );
      registry.endTrace("u4b", { statusCode: 200 });

      const snapshot = (await registry.pluckSnapshot("u4b")) as RequestSnapshot;
      expect(snapshot.attributes?.statusCode).toBe(500);
    });

    it("keeps the internal marker off the shipped snapshot", async () => {
      startRpc("u5");
      const snapshot = await failWith("u5", new Error("deliberate"));

      expect("errorStatusCode" in snapshot).toBe(false);
    });
  });

  describe("manual spans", () => {
    it("runs the callback and returns its value", async () => {
      startRequest("m1");
      const parent = registry.internalStartTraceStep(
        "m1",
        "Svc",
        "root",
        undefined,
      );

      const result = await als.run(
        new Map([[CALLER_METADATA_KEY, parent]]),
        () => registry.createManualSpan("m1", parent, "work", () => "done"),
      );

      expect(result).toBe("done");
    });

    it("nests the manual span under the active one", async () => {
      startRequest("m2");
      const parent = registry.internalStartTraceStep(
        "m2",
        "Svc",
        "root",
        undefined,
      );

      await als.run(new Map([[CALLER_METADATA_KEY, parent]]), () =>
        registry.createManualSpan("m2", parent, "inner-work", async () => "ok"),
      );
      registry.internalEndTraceStep("m2", parent, "Svc", "root", parent);
      registry.endTrace("m2");

      const snapshot = await registry.pluckSnapshot("m2");
      const root = snapshot!.traces[0] as {
        children?: Array<{ name?: string; origin?: string }>;
      };
      expect(root.children?.[0]).toMatchObject({
        name: "inner-work",
        origin: "manual",
      });
    });

    it("re-throws from the callback and records the failure", async () => {
      startRequest("m3");
      const parent = registry.internalStartTraceStep(
        "m3",
        "Svc",
        "root",
        undefined,
      );

      await expect(
        als.run(new Map([[CALLER_METADATA_KEY, parent]]), () =>
          registry.createManualSpan("m3", parent, "failing", async () => {
            throw new Error("inner boom");
          }),
        ),
      ).rejects.toThrow("inner boom");

      registry.internalEndTraceStep("m3", parent, "Svc", "root", parent);
      registry.endTrace("m3");

      const snapshot = await registry.pluckSnapshot("m3");
      const root = snapshot!.traces[0] as {
        children?: Array<{ error?: unknown }>;
      };
      expect(root.children?.[0].error).toBe(true);
    });

    it("still runs the callback outside any active span", async () => {
      // Instrumentation must never be the reason business logic does not run.
      await expect(
        registry.createManualSpan("unknown", "nobody", "orphan", () => "ran"),
      ).resolves.toBe("ran");
    });

    it("does not let a completed manual span mask a leaked auto span", async () => {
      startRequest("m5");
      const parent = registry.internalStartTraceStep(
        "m5",
        "Svc",
        "root",
        undefined,
      );
      // An un-awaited auto span that never completes.
      registry.internalStartTraceStep("m5", "Svc", "leaked", parent);

      // A manual span completes through internalEndTraceStep, which counts it
      // as done - without a matching start count, the two increments cancelled
      // and the half-built tree (with its circular parent reference) shipped.
      await als.run(new Map([[CALLER_METADATA_KEY, parent]]), () =>
        registry.createManualSpan("m5", parent, "quick", () => "ok"),
      );
      registry.internalEndTraceStep("m5", parent, "Svc", "root", parent);
      registry.endTrace("m5");

      await expect(registry.pluckSnapshot("m5")).resolves.toBeUndefined();
    }, 10_000);

    it("records an execution slice under the manual span's own id", async () => {
      // Without an enter() at span start, the exit() on completion no-ops and
      // the span's execution time is attributed to its parent - so profile
      // correlation for manual spans silently found nothing.
      const recorder = new SpanSliceRecorder();
      setActiveSliceRecorder(recorder);
      try {
        startRequest("m6");
        const parent = registry.internalStartTraceStep(
          "m6",
          "Svc",
          "root",
          undefined,
        );

        await als.run(new Map([[CALLER_METADATA_KEY, parent]]), () =>
          registry.createManualSpan("m6", parent, "profiled", () => "ok"),
        );

        const spanIds = recorder.drain().map((slice) => slice.spanId);
        const snapshot = registry.getActiveSpan("m6", parent);
        const manualId = (
          snapshot?.children?.[0] as { spanId?: string } | undefined
        )?.spanId;
        expect(manualId).toBeDefined();
        expect(spanIds).toContain(manualId);
      } finally {
        setActiveSliceRecorder(null);
      }
    });
  });

  describe("repeated siblings", () => {
    /** Opens and closes `count` calls of one frame under `callerId`. */
    const repeat = (
      traceId: string,
      callerId: string | undefined,
      className: string,
      methodKey: string,
      count: number,
    ) => {
      for (let i = 0; i < count; i++) {
        const id = registry.internalStartTraceStep(
          traceId,
          className,
          methodKey,
          callerId,
        );
        registry.internalEndTraceStep(traceId, id, className, methodKey, id);
      }
    };

    type Pipe = {
      duration: number;
      tags?: Record<string, unknown>;
      error?: unknown;
      spanId?: string;
    };
    const pipesUnder = (node: { children?: unknown[] }) =>
      (node.children ?? []).filter(
        (child) =>
          (child as { className: string }).className === "ValidationPipe",
      ) as Pipe[];
    const countOf = (pipe: Pipe) => pipe.tags?.[SPAN_COLLAPSED_TAG];

    it("collapses repeated siblings on the way out, with the defaults in force", async () => {
      startRequest("c1");
      const root = registry.internalStartTraceStep(
        "c1",
        "OrdersResolver",
        "orders",
        undefined,
      );
      // Interleaved, as a pipe run per argument is with the resolver calls
      // it validates for.
      for (let i = 0; i < 30; i++) {
        repeat("c1", root, "ValidationPipe", "transform", 1);
        repeat("c1", root, "PricingService", "quote", 1);
      }
      registry.internalEndTraceStep(
        "c1",
        root,
        "OrdersResolver",
        "orders",
        root,
      );
      registry.endTrace("c1");

      const snapshot = await registry.pluckSnapshot("c1");
      const [operation] = snapshot!.traces as Array<{ children?: unknown[] }>;

      // Three kept whole plus one aggregate, out of thirty.
      const pipes = pipesUnder(operation);
      expect(pipes).toHaveLength(4);
      const collapsed = pipes.filter((pipe) => countOf(pipe) !== undefined);
      expect(collapsed).toHaveLength(1);
      expect(countOf(collapsed[0])).toBe(27);
      expect(collapsed[0]).toMatchObject({
        name: "ValidationPipe.transform ×27",
        origin: "auto",
        startOffset: expect.any(Number),
        spanId: expect.any(String),
      });
      // The kept ones are the slowest, so each outlasts the average of the rest.
      const mean = collapsed[0].duration / 27;
      for (const kept of pipes.filter((pipe) => countOf(pipe) === undefined)) {
        expect(kept.duration).toBeGreaterThanOrEqual(mean);
      }
    });

    it("ships every span when collapsing is switched off", async () => {
      registry.configureSpanCollapse(undefined);
      startRequest("c2");
      const root = registry.internalStartTraceStep(
        "c2",
        "OrdersResolver",
        "orders",
        undefined,
      );
      repeat("c2", root, "ValidationPipe", "transform", 30);
      registry.internalEndTraceStep(
        "c2",
        root,
        "OrdersResolver",
        "orders",
        root,
      );
      registry.endTrace("c2");

      const snapshot = await registry.pluckSnapshot("c2");
      const [operation] = snapshot!.traces as Array<{ children?: unknown[] }>;

      expect(pipesUnder(operation)).toHaveLength(30);
    });

    it("applies configured settings", async () => {
      registry.configureSpanCollapse({ threshold: 5, keepSlowest: 1 });
      startRequest("c3");
      const root = registry.internalStartTraceStep(
        "c3",
        "OrdersResolver",
        "orders",
        undefined,
      );
      repeat("c3", root, "ValidationPipe", "transform", 10);
      registry.internalEndTraceStep(
        "c3",
        root,
        "OrdersResolver",
        "orders",
        root,
      );
      registry.endTrace("c3");

      const snapshot = await registry.pluckSnapshot("c3");
      const [operation] = snapshot!.traces as Array<{ children?: unknown[] }>;

      const pipes = pipesUnder(operation);
      expect(pipes).toHaveLength(2);
      expect(countOf(pipes.find((pipe) => countOf(pipe) !== undefined)!)).toBe(
        9,
      );
    });

    it("keeps a failed instance whole", async () => {
      startRequest("c4");
      const root = registry.internalStartTraceStep(
        "c4",
        "OrdersResolver",
        "orders",
        undefined,
      );
      repeat("c4", root, "ValidationPipe", "transform", 25);
      const failing = registry.internalStartTraceStep(
        "c4",
        "ValidationPipe",
        "transform",
        root,
      );
      registry.internalEndTraceStep(
        "c4",
        failing,
        "ValidationPipe",
        "transform",
        failing,
        new BadRequestException("factor must be positive"),
      );
      registry.internalEndTraceStep(
        "c4",
        root,
        "OrdersResolver",
        "orders",
        root,
      );
      registry.endTrace("c4");

      const snapshot = await registry.pluckSnapshot("c4");
      const [operation] = snapshot!.traces as Array<{ children?: unknown[] }>;

      const pipes = pipesUnder(operation);
      expect(pipes.find((pipe) => pipe.spanId === failing)).toMatchObject({
        error: true,
      });
      expect(countOf(pipes.find((pipe) => countOf(pipe) !== undefined)!)).toBe(
        22,
      );
    });
  });

  /**
   * `skipSpans` exists to stop billing for the spans of requests turned away
   * on purpose - a 404 for a record that does not exist. What must hold is
   * that only the tree goes: the operation's row, status and error are what
   * the charts and the Errors page are built from.
   */
  describe("skipped spans", () => {
    /** A root span with one child under it, the root failing with `error`. */
    const failWith = (traceId: string, error?: unknown) => {
      const rootId = registry.internalStartTraceStep(
        traceId,
        "ContactsController",
        "findOne",
        undefined,
      );
      const childId = registry.internalStartTraceStep(
        traceId,
        "ContactsService",
        "findOne",
        rootId,
      );
      registry.internalEndTraceStep(
        traceId,
        childId,
        "ContactsService",
        "findOne",
        childId,
        error as never,
      );
      registry.internalEndTraceStep(
        traceId,
        rootId,
        "ContactsController",
        "findOne",
        rootId,
        error as never,
      );
    };

    it("ships a request that ended with a listed status without its spans, but with its error", async () => {
      registry.configureSkipSpans(resolveSkipSpans([404]));
      startRequest("s1");
      failWith("s1", new NotFoundException("Contact not found"));
      registry.endTrace("s1", { statusCode: 404, userId: "u-1" });

      const snapshot = (await registry.pluckSnapshot("s1")) as RequestSnapshot;

      expect(snapshot.traces).toEqual([]);
      expect(snapshot.attributes?.statusCode).toBe(404);
      expect(snapshot.userId).toBe("u-1");
      expect(snapshot.duration).toEqual(expect.any(Number));
      expect(snapshot.error).toMatchObject({
        cls: "NotFoundException",
        message: "Contact not found",
      });
    });

    it("keeps the spans of a status the list does not name", async () => {
      registry.configureSkipSpans(resolveSkipSpans([404]));
      startRequest("s2");
      failWith("s2");
      registry.endTrace("s2", { statusCode: 200 });

      const snapshot = await registry.pluckSnapshot("s2");

      expect(snapshot!.traces).toHaveLength(1);
    });

    it("tells a function what the operation finished as, and follows its answer", async () => {
      const rule = vi.fn(() => false);
      registry.configureSkipSpans(rule);
      startRequest("s3");
      failWith("s3", new NotFoundException());
      registry.endTrace("s3", { statusCode: 404 });

      const snapshot = await registry.pluckSnapshot("s3");

      expect(rule).toHaveBeenCalledWith({
        protocol: "http",
        operationId: "GET /orders",
        method: "GET",
        statusCode: 404,
        duration: expect.any(Number),
        errorClass: "NotFoundException",
      });
      expect(snapshot!.traces).toHaveLength(1);
    });

    it("judges a transport without a status of its own by the status its exception earned", async () => {
      registry.configureSkipSpans(resolveSkipSpans([404]));
      const startRpc = (traceId: string) =>
        registry.startTrace(traceId, {
          operationId: "contacts.find",
          protocol: "TCP",
          tags: {},
        });

      startRpc("s4");
      failWith("s4", new NotFoundException());
      registry.endTrace("s4");
      const failed = (await registry.pluckSnapshot("s4")) as RequestSnapshot;

      startRpc("s5");
      failWith("s5");
      registry.endTrace("s5");
      const succeeded = await registry.pluckSnapshot("s5");

      expect(failed.traces).toEqual([]);
      expect(failed.attributes?.statusCode).toBe(404);
      // No status at all: nothing for a list of status codes to match.
      expect(succeeded!.traces).toHaveLength(1);
    });

    it("never asks about a job", async () => {
      const rule = vi.fn(() => true);
      registry.configureSkipSpans(rule);
      registry.startTrace("s6", {
        id: "job-1",
        traceId: "s6",
        name: "send-mail",
        queueName: "mail",
      } as never);
      failWith("s6", new NotFoundException());
      registry.endTrace("s6", { status: "failed" });

      const snapshot = await registry.pluckSnapshot("s6");

      expect(rule).not.toHaveBeenCalled();
      expect(snapshot!.traces).toHaveLength(1);
    });

    it("keeps the spans when the function throws, and says so once", async () => {
      const warn = vi
        .spyOn((registry as unknown as { logger: Logger }).logger, "warn")
        .mockImplementation(() => undefined);
      registry.configureSkipSpans(() => {
        throw new Error("bad rule");
      });

      for (const traceId of ["s7", "s8"]) {
        startRequest(traceId);
        failWith(traceId, new NotFoundException());
        registry.endTrace(traceId, { statusCode: 404 });
        const snapshot = await registry.pluckSnapshot(traceId);
        expect(snapshot!.traces).toHaveLength(1);
      }
      // Once, not per request: a rule that throws throws on every request.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad rule"));
    });
  });

  describe("incomplete snapshots", () => {
    it("abandons a snapshot whose spans never closed", async () => {
      startRequest("i1");
      registry.internalStartTraceStep("i1", "Svc", "leaked", undefined);
      registry.endTrace("i1");

      // An un-awaited async call leaves a span open; rather than shipping a
      // half-built tree, the snapshot waits and is then dropped.
      await expect(registry.pluckSnapshot("i1")).resolves.toBeUndefined();
    }, 10_000);

    it("does not leak the trace after abandoning it", async () => {
      startRequest("i2");
      registry.internalStartTraceStep("i2", "Svc", "leaked", undefined);
      registry.endTrace("i2");
      await registry.pluckSnapshot("i2");

      // Cleanup runs on the abandon path too, or a busy process accumulates a
      // snapshot per un-awaited call for the lifetime of the process.
      expect(registry.getActiveSpan("i2", "anything")).toBeUndefined();
    }, 10_000);

    it("warns once, not per span, when a trace is dropped for a span that outlived it", async () => {
      const logger = (registry as unknown as { logger: Logger }).logger;
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const error = vi.spyOn(logger, "error").mockImplementation(() => {});

      startRequest("i3");
      const handler = registry.internalStartTraceStep(
        "i3",
        "OrdersController",
        "create",
        undefined,
      );
      // Started by the handler and not awaited - an email sent in the
      // background - so it is still running when the handler returns.
      const mail = registry.internalStartTraceStep(
        "i3",
        "MailService",
        "send",
        handler,
      );
      registry.internalEndTraceStep(
        "i3",
        handler,
        "OrdersController",
        "create",
        handler,
      );
      registry.endTrace("i3");
      await expect(registry.pluckSnapshot("i3")).resolves.toBeUndefined();

      // Once, when the trace is given up on, naming the span that held it.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('"MailService#send"'),
      );

      // Its late end adds nothing.
      registry.internalEndTraceStep("i3", mail, "MailService", "send", mail);

      expect(error).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
    }, 10_000);
  });
});
