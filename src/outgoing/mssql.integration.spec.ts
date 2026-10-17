import { AsyncLocalStorage } from "node:async_hooks";
import { errorMonitor } from "node:events";
import mssql from "mssql";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OngoingTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import {
  CALLER_METADATA_KEY,
  TRACE_REGISTRY_KEY,
} from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { patchMssql } from "./mssql.integration.js";
import { OutgoingObserveAgentService } from "./outgoing-observe-agent.service.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";

type Callback = (this: unknown, error: unknown, ...rest: any[]) => unknown;
type Implementation = (
  this: mssql.Request,
  command: string,
  callback: Callback,
  ...rest: unknown[]
) => unknown;

function createRecorder(sampled = true) {
  const nodes: Array<
    OngoingTraceEventNode & {
      registryKey: string;
      callerId?: string;
      className: string;
      operation: string;
      ends: unknown[];
    }
  > = [];
  const storage = new AsyncLocalStorage<Map<any, any>>();
  const registry = new OperationTraceRegistry(storage, false);
  vi.spyOn(registry, "internalStartTraceStep").mockImplementation(
    (registryKey, className, operation, callerId) => {
      if (!sampled) {
        return undefined;
      }
      const id = String(nodes.length);
      nodes.push({
        registryKey,
        callerId,
        className,
        operation,
        methodKey: operation,
        type: "start",
        origin: "auto",
        startTime: 0,
        children: [],
        ends: [],
      });
      return id;
    },
  );
  vi.spyOn(registry, "getActiveSpan").mockImplementation(
    (_key, id) => nodes[Number(id)],
  );
  vi.spyOn(registry, "internalEndTraceStep").mockImplementation(
    (_key, id, _className, _operation, _callerId, error) => {
      nodes[Number(id)].ends.push(error);
    },
  );
  const recorder = new OutgoingSpanRecorder(registry, storage, "traceId");
  return {
    registry,
    storage,
    recorder,
    nodes,
    run: <T>(fn: () => T) =>
      storage.run(
        new Map([
          [TRACE_REGISTRY_KEY, "request-1"],
          ["traceId", "reported-id"],
          [CALLER_METADATA_KEY, "parent-span"],
        ]),
        fn,
      ),
  };
}

function harness(
  implementation: { query?: Implementation; execute?: Implementation } = {},
  sampled = true,
) {
  const state = createRecorder(sampled);
  const calls: Array<{ command: string; inputs: mssql.IRequestParameters }> =
    [];
  class Request extends mssql.Request {
    _query(command: string, callback: Callback, ...rest: unknown[]) {
      calls.push({ command, inputs: { ...this.parameters } });
      if (implementation.query) {
        return implementation.query.call(this, command, callback, ...rest);
      }
      return queueMicrotask(() =>
        callback(null, [[{ value: 1 }]], {}, [1], {}),
      );
    }

    _execute(command: string, callback: Callback, ...rest: unknown[]) {
      calls.push({ command, inputs: { ...this.parameters } });
      if (implementation.execute) {
        return implementation.execute.call(this, command, callback, ...rest);
      }
      return queueMicrotask(() =>
        callback(null, [[{ value: 1 }]], {}, 7, [1], {}),
      );
    }
  }
  expect(patchMssql({ Request }, state.recorder)).toBe(true);
  return { ...state, Request, calls };
}

describe("patchMssql", () => {
  it("preserves promise results and attaches sanitized spans to the active parent", async () => {
    const h = harness();
    const request = new h.Request();
    request.input("p1", mssql.Int, 123456);
    const result = await h.run(() =>
      request.query(
        "SELECT * FROM [dbo].[orders] WHERE id = @p1 AND note = N'private-value'",
      ),
    );
    expect(result.recordset).toEqual([{ value: 1 }]);
    expect(h.calls[0].inputs.p1.value).toBe(123456);
    expect(h.nodes).toMatchObject([
      {
        registryKey: "request-1",
        callerId: "parent-span",
        className: "mssql",
        operation: "SELECT dbo.orders",
        tags: {
          "db.system": "mssql",
          "db.statement":
            "SELECT * FROM [dbo].[orders] WHERE id = @p1 AND note = ?",
        },
        ends: [undefined],
      },
    ]);
  });

  it.each(["query", "batch", "execute"] as const)(
    "preserves %s callback results and the public Request return value",
    async (method) => {
      const h = harness();
      const request = new h.Request();
      await h.run(
        () =>
          new Promise<void>((resolve, reject) => {
            const returned = request[method]("command", (error, result) => {
              try {
                expect(error).toBeNull();
                expect(result?.recordset).toEqual([{ value: 1 }]);
                resolve();
              } catch (failure) {
                reject(failure);
              }
            });
            expect(returned).toBe(request);
          }),
      );
      expect(h.nodes[0].ends).toEqual([undefined]);
    },
  );

  it("preserves internal receivers, all arguments and synchronous return values", () => {
    const receiver = {};
    const returned = {};
    const extra = {};
    const h = harness({
      query(command, callback, ...rest) {
        expect(this).toBe(request);
        expect(command).toBe("SELECT 42");
        expect(rest).toEqual([extra]);
        expect(callback.call(receiver, null, 42, extra)).toBe(
          "callback result",
        );
        return returned;
      },
    });
    const request = new h.Request();
    const result = h.run(() =>
      request._query(
        "SELECT 42",
        function (error, value, trailing) {
          expect(this).toBe(receiver);
          expect([error, value, trailing]).toEqual([null, 42, extra]);
          return "callback result";
        },
        extra,
      ),
    );
    expect(result).toBe(returned);
    expect(h.nodes[0].ends).toEqual([undefined]);
  });

  it("records just one span for a batch, even after repeat patching", async () => {
    const h = harness();
    patchMssql({ Request: h.Request }, h.recorder);
    await h.run(() => new h.Request().batch("SELECT 1; SELECT 2;"));
    expect(h.calls).toHaveLength(1);
    expect(h.nodes).toHaveLength(1);
    expect(h.nodes[0].ends).toEqual([undefined]);
  });

  it.each(["query", "batch"] as const)(
    "expands %s tagged templates without recording bound parameter values",
    async (method) => {
      const h = harness();
      await h.run(
        () =>
          new h.Request()[
            method
          ]`SELECT * FROM orders WHERE note = ${"private-input"}`,
      );
      expect(h.calls[0].inputs.param1.value).toBe("private-input");
      expect(h.nodes[0].tags?.["db.statement"]).toBe(
        "SELECT * FROM orders WHERE note = @param1",
      );
    },
  );

  it("records stored procedure names, not their input values", async () => {
    const h = harness();
    const request = new h.Request();
    request.input("secret", mssql.VarChar, "private-input");
    const result = await h.run(() => request.execute("dbo.ProcessOrder"));
    expect(result.returnValue).toBe(7);
    expect(h.calls[0].inputs.secret.value).toBe("private-input");
    expect(h.nodes[0]).toMatchObject({
      operation: "EXEC dbo.ProcessOrder",
      tags: { "db.statement": "EXEC dbo.ProcessOrder" },
      ends: [undefined],
    });
    await h.run(() => new h.Request().execute(`dbo.${"p".repeat(100)}`));
    expect(h.nodes[1].operation).toHaveLength(64);
  });

  it.each(["query", "batch", "execute"] as const)(
    "retains callback and promise errors for %s",
    async (method) => {
      const error = new Error("query failed");
      const fail: Implementation = (_command, callback) =>
        queueMicrotask(() => callback(error));
      const h = harness({ query: fail, execute: fail });
      await expect(
        h.run(() => new h.Request()[method]("command")),
      ).rejects.toBe(error);
      await h.run(
        () =>
          new Promise<void>((resolve, reject) => {
            void new h.Request()[method]("command", (failure) => {
              try {
                expect(failure).toBe(error);
                resolve();
              } catch (caught) {
                reject(caught);
              }
            });
          }),
      );
      expect(h.nodes.map((node) => node.ends)).toEqual([[error], [error]]);
    },
  );

  it("closes synchronous failures and removes the error monitor", () => {
    const error = new Error("synchronous failure");
    const h = harness({
      query() {
        throw error;
      },
    });
    const request = new h.Request();
    expect(() => h.run(() => request._query("SELECT 1", vi.fn()))).toThrow(
      error,
    );
    expect(h.nodes[0].ends).toEqual([error]);
    expect(request.listenerCount(errorMonitor)).toBe(0);
  });

  it("keeps the span open while waiting for pool checkout and completion", async () => {
    let complete: Callback | undefined;
    const h = harness({
      query(_command, callback) {
        complete = callback;
      },
    });
    const request = new h.Request();
    const pending = h.run(() => request.query("SELECT 1"));
    expect(h.nodes[0].ends).toEqual([]);
    complete?.(null, [[{ value: 1 }]], {}, [1], {});
    await pending;
    expect(h.nodes[0].ends).toEqual([undefined]);
    expect(request.listenerCount(errorMonitor)).toBe(0);
  });

  it.each(["query", "batch", "execute"] as const)(
    "retains the first streaming error when %s completes with a null error",
    async (method) => {
      const error = new Error("stream failure");
      const fail: Implementation = function (_command, callback) {
        queueMicrotask(() => {
          this.emit("error", error);
          this.emit("error", new Error("later failure"));
          callback(null, null, {}, 0, {});
        });
      };
      const h = harness({ query: fail, execute: fail });
      const request = new h.Request();
      request.stream = true;
      const errors = vi.fn();
      const done = vi.fn();
      request.on("error", errors);
      request.on("done", done);
      await h.run(() => request[method]("command"));
      expect(errors).toHaveBeenCalledTimes(2);
      expect(errors).toHaveBeenNthCalledWith(1, error);
      expect(done).toHaveBeenCalledTimes(1);
      expect(h.nodes[0].ends).toEqual([error]);
      expect(request.listenerCount(errorMonitor)).toBe(0);
    },
  );

  it("does not swallow unhandled stream errors", () => {
    const error = new Error("unhandled stream failure");
    const h = harness({
      query() {
        this.emit("error", error);
      },
    });
    const request = new h.Request();
    expect(() => h.run(() => request._query("SELECT 1", vi.fn()))).toThrow(
      error,
    );
    expect(h.nodes[0].ends).toEqual([error]);
    expect(request.listenerCount("error")).toBe(0);
    expect(request.listenerCount(errorMonitor)).toBe(0);
  });

  it.each([true, false])(
    "leaves untraced and sampled-out calls unchanged (sampled=%s)",
    async (sampled) => {
      const h = harness(
        {
          query(_command, callback) {
            expect(this.listenerCount(errorMonitor)).toBe(0);
            queueMicrotask(() => callback(null, [], {}, [], {}));
          },
        },
        sampled,
      );
      const request = new h.Request();
      if (sampled) {
        await request.query("SELECT 1");
      } else {
        await h.run(() => request.query("SELECT 1"));
      }
      expect(h.nodes).toEqual([]);
    },
  );

  it("traces queries issued by a completion callback independently", async () => {
    const h = harness();
    await h.run(
      () =>
        new Promise((resolve, reject) => {
          new h.Request().query("SELECT 1", () => {
            new h.Request().query("SELECT 2").then(resolve, reject);
          });
        }),
    );
    expect(h.nodes.map((node) => node.ends)).toEqual([
      [undefined],
      [undefined],
    ]);
  });

  it("passes unsupported argument shapes through without opening a span", () => {
    const original = vi.fn((..._args: unknown[]) => "unchanged");
    class Request {
      _query(...args: unknown[]) {
        return original(...args);
      }
    }
    const h = createRecorder();
    patchMssql({ Request }, h.recorder);
    const request = new Request();
    for (const args of [[{}, vi.fn()], ["SELECT 1"], [null, null]]) {
      expect(h.run(() => request._query(...args))).toBe("unchanged");
      expect(original).toHaveBeenLastCalledWith(...args);
    }
    expect(h.nodes).toEqual([]);
  });

  it("ignores absent or incompatible drivers", () => {
    const h = createRecorder();
    expect(patchMssql({}, h.recorder)).toBe(false);
    expect(patchMssql({ Request: { prototype: {} } }, h.recorder)).toBe(false);
  });
});

describe("MSSQL statement sanitization", () => {
  it.each([
    [
      "SELECT N'private''value', 'path\\', 'another-secret', 0xDEADBEEF, 123.45, $987.65, @p1 " +
        "FROM [dbo].[orders] /* outer ' /* nested */ private-comment */ " +
        "WHERE note = '--not-a-comment' -- private-line-comment\n",
      "SELECT ?, ?, ?, ?, ?, ?, @p1 FROM [dbo].[orders] WHERE note = ?",
    ],
    [
      `SELECT [123], [a]]b], "456", "a""b", [--keep], "/*keep*/" FROM [dbo].[orders2] WHERE col1 = -1.5e-3 AND x IN (1, 2, 3)`,
      `SELECT [123], [a]]b], "456", "a""b", [--keep], "/*keep*/" FROM [dbo].[orders2] WHERE col1 = ? AND x IN (?)`,
    ],
    ["SELECT 0x0123\\\nDEADBEEF, 1", "SELECT ?, ?"],
    ["SELECT 0x0123\\\r\nDEAD\\\rBEEF FROM t", "SELECT ? FROM t"],
    ["SELECT 1--private\rFROM orders", "SELECT ? FROM orders"],
    ["SELECT .5, $ -12.5, 0XCAFE, n'private'", "SELECT ?, ?, ?, ?"],
  ])("redacts %s", async (sql, expected) => {
    const h = harness();
    await h.run(() => new h.Request().query(sql));
    expect(h.nodes[0].tags?.["db.statement"]).toBe(expected);
  });

  it.each(["query", "batch"] as const)(
    "redacts named and positional bare EXEC arguments from %s calls",
    async (method) => {
      const h = harness();
      await h.run(() =>
        new h.Request()[method](
          "EXEC dbo.Authenticate @password = PrivateToken123",
        ),
      );
      await h.run(() =>
        new h.Request()[method]("EXEC dbo.Authenticate PrivateToken456"),
      );
      expect(h.nodes.map((node) => node.tags?.["db.statement"])).toEqual([
        "EXEC dbo.Authenticate ?",
        "EXEC dbo.Authenticate ?",
      ]);
      expect(JSON.stringify(h.nodes)).not.toMatch(/PrivateToken/);
    },
  );

  it.each(["query", "batch"] as const)(
    "omits statements for implicit procedure calls from %s calls",
    async (method) => {
      const h = harness();
      for (const sql of [
        "dbo.Authenticate @password = PrivateNamedToken123",
        "Authenticate PrivatePositionalToken456; SELECT 42",
        "[SELECT] PrivateBracketedToken",
        "select$proc PrivateSuffixedToken",
        "SELECT客户 @password = PrivateUnicodeNamedToken",
        "SELECTé PrivateUnicodePositionalToken",
      ]) {
        await h.run(() => new h.Request()[method](sql));
      }
      expect(h.nodes).toHaveLength(6);
      for (const node of h.nodes) {
        expect(node.tags).toEqual({ "db.system": "mssql" });
      }
      expect(JSON.stringify(h.nodes)).not.toMatch(/Private/);
    },
  );

  it.each([
    ["SAVE TRANSACTION typeorm_1", "SAVE"],
    ["ROLLBACK TRANSACTION typeorm_1", "ROLLBACK"],
    ["DECLARE @t TABLE (id int)", "DECLARE"],
  ])(
    "records but does not capture other statements: %s",
    async (sql, operation) => {
      const h = harness();
      await h.run(() => new h.Request().query(sql));
      expect(h.nodes[0]).toMatchObject({
        operation: operation.toUpperCase(),
        tags: { "db.system": "mssql" },
      });
      expect(h.nodes[0].tags).not.toHaveProperty("db.statement");
    },
  );

  it.each(["query", "batch"] as const)(
    "does not leak procedure arguments through the operation for %s calls",
    async (method) => {
      const h = harness();
      for (const sql of [
        "SELECT$FROM PrivateToken123",
        "SELECT$FROM @password = PrivateNamedToken456",
      ]) {
        await h.run(() => new h.Request()[method](sql));
      }
      expect(h.nodes.map((node) => node.operation)).toEqual([
        "SELECT",
        "SELECT",
      ]);
      for (const node of h.nodes) {
        expect(node.tags).toEqual({ "db.system": "mssql" });
      }
      expect(JSON.stringify(h.nodes)).not.toMatch(/Private/);
    },
  );

  it.each([
    ["(SELECT 1) UNION SELECT 2", "(SELECT ?) UNION SELECT ?"],
    [
      "with x AS (SELECT 1) SELECT * FROM x",
      "with x AS (SELECT ?) SELECT * FROM x",
    ],
    ["MERGE [t] USING s ON 1 = 1", "MERGE [t] USING s ON ? = ?"],
    ["execute dbo.Process 1", "execute dbo.Process ?"],
  ])("captures statements opening with %s", async (sql, statement) => {
    const h = harness();
    await h.run(() => new h.Request().query(sql));
    expect(h.nodes[0].tags?.["db.statement"]).toBe(statement);
  });

  it("redacts EXEC arguments in a multi-statement batch", async () => {
    const h = harness();
    await h.run(() =>
      new h.Request().batch(
        "SELECT 1; EXEC dbo.Authenticate PrivateToken123; SELECT 2",
      ),
    );
    expect(h.nodes[0].tags?.["db.statement"]).toBe(
      "SELECT ?; EXEC dbo.Authenticate ?; SELECT ?",
    );
  });

  it.each(["query", "batch"] as const)(
    "redacts every EXEC argument after a long first argument in %s calls",
    async (method) => {
      const h = harness();
      const firstSecret = "PrivateFirstArgument".repeat(10);
      const sql = `EXEC dbo.Authenticate ${firstSecret}; EXEC dbo.Authenticate PrivateToken456`;
      await h.run(() => new h.Request()[method](sql));
      expect(h.nodes[0].tags?.["db.statement"]).toBe(
        "EXEC dbo.Authenticate ?; EXEC dbo.Authenticate ?",
      );
      expect(JSON.stringify(h.nodes)).not.toMatch(/Private/);
    },
  );

  it.each([undefined, true, false])(
    "respects enableQuotedIdentifier=%s for pool, transaction and prepared-statement requests",
    async (enableQuotedIdentifier) => {
      const h = harness();
      const pool = new mssql.ConnectionPool({
        server: "localhost",
        options: { enableQuotedIdentifier },
      });
      const transaction = new mssql.Transaction(pool);
      const requests = [
        new h.Request(pool),
        new h.Request(transaction),
        new h.Request(new mssql.PreparedStatement(pool)),
        new h.Request(new mssql.PreparedStatement(transaction)),
      ];
      const quoted = enableQuotedIdentifier !== false;
      const sql = quoted
        ? `SELECT "o"."id" FROM "dbo"."orders" "o" WHERE "o"."note" = N'private-value'`
        : `SELECT "private""value", "/*private-comment*/" FROM [dbo].[orders] WHERE note = N'private-value'`;
      const statement = quoted
        ? `SELECT "o"."id" FROM "dbo"."orders" "o" WHERE "o"."note" = ?`
        : "SELECT ?, ? FROM [dbo].[orders] WHERE note = ?";
      for (const request of requests) {
        for (const method of ["query", "batch"] as const) {
          await h.run(() => request[method](sql));
        }
      }
      expect(h.nodes).toHaveLength(requests.length * 2);
      for (const node of h.nodes) {
        expect(node).toMatchObject({
          operation: "SELECT dbo.orders",
          tags: { "db.statement": statement },
          ends: [undefined],
        });
      }
    },
  );

  it.each(['SELECT "private-value', `SELECT "${"private-value".repeat(1000)}`])(
    "redacts unterminated and truncated double-quoted strings when enableQuotedIdentifier=false: %.40s",
    async (sql) => {
      const h = harness();
      const pool = new mssql.ConnectionPool({
        server: "localhost",
        options: { enableQuotedIdentifier: false },
      });
      await h.run(() => new h.Request(pool).query(sql));
      expect(h.nodes[0].tags?.["db.statement"]).toBe("SELECT ?");
    },
  );

  it.each([
    `SELECT N'${"private-value".repeat(1000)}`,
    "SELECT 1 /* private-comment",
    "SELECT 1 /* outer /* inner */ private-comment",
    "SELECT 'private-value",
  ])(
    "does not leak truncated strings or unterminated comments: %.40s",
    async (sql) => {
      const h = harness();
      await h.run(() => new h.Request().query(sql));
      const statement = h.nodes[0].tags?.["db.statement"];
      expect(statement).not.toMatch(/private/);
      expect(String(statement).length).toBeLessThanOrEqual(2048);
    },
  );

  it("bounds both input processing and exported statements", async () => {
    const h = harness();
    await h.run(() =>
      new h.Request().query(`SELECT ${"a,".repeat(5000)} private-tail`),
    );
    const statement = String(h.nodes[0].tags?.["db.statement"]);
    expect(statement).toHaveLength(2048);
    expect(statement).not.toContain("private-tail");
    await h.run(() =>
      new h.Request().query(`/* ${"x".repeat(8192)} */ SELECT 1`),
    );
    expect(h.nodes[1]).toMatchObject({
      operation: "QUERY",
      tags: { "db.system": "mssql" },
    });
    expect(h.nodes[1].tags).not.toHaveProperty("db.statement");
  });

  it("redacts a numeric token cut off at the input boundary", async () => {
    const h = harness();
    await h.run(() =>
      new h.Request().query(`SELECT /*${"x".repeat(8173)}*/ 987654e+2`),
    );
    expect(h.nodes[0]).toMatchObject({
      operation: "SELECT",
      tags: {
        "db.system": "mssql",
        "db.statement": "SELECT ?",
      },
    });
    expect(JSON.stringify(h.nodes)).not.toMatch(/987654/);
  });
});

describe("MSSQL startup registration", () => {
  it("enables MSSQL automatically and respects outgoing opt-outs", async () => {
    const h = createRecorder();
    const prototype = mssql.Request.prototype;
    const methods = ["_query", "_execute"];
    const originals = methods.map((method) => ({
      method,
      descriptor: Object.getOwnPropertyDescriptor(prototype, method)!,
      key: Symbol.for(`nestjs.observe.original.${method}`),
    }));
    const start = (outgoing: ObserveModuleOptionsWithDefaults["outgoing"]) =>
      new OutgoingObserveAgentService(
        { outgoing, traceIdKey: "traceId" } as ObserveModuleOptionsWithDefaults,
        h.registry,
        h.storage,
      );
    try {
      for (const outgoing of [
        false,
        { database: false, http: false },
      ] as const) {
        start(outgoing);
        for (const { method, descriptor } of originals) {
          expect(Reflect.get(prototype, method)).toBe(descriptor.value);
        }
      }
      start({ http: false });
      // The real driver fails without a pool, so this needs no SQL Server.
      await expect(
        h.run(() => new mssql.Request().query("SELECT 1")),
      ).rejects.toMatchObject({ code: "ENOCONN" });
      expect(h.nodes).toHaveLength(1);
      expect(h.nodes[0].tags?.["db.system"]).toBe("mssql");
      expect(h.nodes[0].ends[0]).toMatchObject({ code: "ENOCONN" });
    } finally {
      for (const { method, descriptor, key } of originals) {
        Object.defineProperty(prototype, method, descriptor);
        Reflect.deleteProperty(prototype, key);
      }
    }
  });
});
