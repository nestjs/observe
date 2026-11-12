import { AsyncLocalStorage } from "async_hooks";
import { EventEmitter } from "events";
import { describeMongoCommand, patchMongodb } from "./mongodb.integration.js";
import { patchMysql2 } from "./mysql2.integration.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import { patchPg } from "./pg.integration.js";

/** A recorder that opens a span for every call and remembers how it ended. */
const fakeRecorder = () => {
  const spans: Array<{
    className: string;
    methodKey: string;
    tags: Record<string, unknown>;
    ended: number;
    error?: unknown;
  }> = [];
  const recorder = {
    open: (
      className: string,
      methodKey: string,
      tags: Record<string, unknown>,
    ) => {
      const span = {
        className,
        methodKey,
        tags,
        ended: 0,
        error: undefined as unknown,
      };
      spans.push(span);
      return {
        end: (error?: unknown) => {
          span.ended += 1;
          span.error = error;
        },
      };
    },
    cover: <T>(fn: () => T) => fn(),
    endWhenSettled: OutgoingSpanRecorder.prototype.endWhenSettled,
  } as unknown as OutgoingSpanRecorder;
  return { recorder, spans };
};

describe("patchMethod", () => {
  it("patches the prototype that owns the method, once, however often it is asked", () => {
    class Base {
      query() {
        return "original";
      }
    }
    class Derived extends Base {}
    const wrap = (original: () => string) =>
      function (this: unknown) {
        return `wrapped(${original.call(this)})`;
      };

    expect(patchMethod(Derived.prototype, "query", wrap)).toBe(true);
    expect(patchMethod(Derived.prototype, "query", wrap)).toBe(true);

    expect(Object.hasOwn(Derived.prototype, "query")).toBe(false);
    expect(new Base().query()).toBe("wrapped(original)");
    expect(patchMethod(Derived.prototype, "missing", wrap)).toBe(false);
  });
});

describe("patchMysql2", () => {
  /** mysql2's shape: a command object comes back, completion goes to `onResult`. */
  const fakeMysql2 = () => {
    const commands: any[] = [];
    class BaseConnection {
      query(sql: any, _values?: unknown, callback?: any) {
        const command =
          typeof sql === "object"
            ? sql
            : Object.assign(new EventEmitter(), { sql, onResult: callback });
        commands.push(command);
        return command;
      }
      execute(sql: any, _values?: unknown, callback?: any) {
        // Its own path, as in the real driver - not a call through `query`.
        const command =
          typeof sql === "object"
            ? sql
            : Object.assign(new EventEmitter(), { sql, onResult: callback });
        commands.push(command);
        return command;
      }
    }
    class Connection extends BaseConnection {}
    class BasePool {
      connection = new Connection();
      query(sql: string, values?: unknown, callback?: any) {
        const command = Object.assign(new EventEmitter(), {
          sql,
          onResult: callback,
        });
        // As the real pool does: the command reaches a connection later.
        queueMicrotask(() => this.connection.query(command));
        return command;
      }
      execute(sql: string, _values?: unknown, callback?: any) {
        const command = Object.assign(new EventEmitter(), {
          sql,
          onResult: callback,
        });
        queueMicrotask(() => this.connection.execute(command));
        return command;
      }
    }
    class Pool extends BasePool {}
    return { module: { Connection, Pool }, commands };
  };

  it("ends the span through the callback, with the error it was given", () => {
    const { module, commands } = fakeMysql2();
    const { recorder, spans } = fakeRecorder();
    patchMysql2(module, recorder);
    const callback = vi.fn();

    new module.Connection().query(
      "SELECT * FROM users WHERE id = 5",
      [],
      callback,
    );
    expect(spans[0]).toMatchObject({
      className: "mysql2",
      methodKey: "SELECT users",
      tags: {
        "db.system": "mysql",
        "db.statement": "SELECT * FROM users WHERE id = ?",
      },
      ended: 0,
    });

    const failure = new Error("deadlock");
    commands[0].onResult(failure, null);
    expect(spans[0]).toMatchObject({ ended: 1, error: failure });
    expect(callback).toHaveBeenCalledWith(failure, null);
  });

  it("opens one span for a pool query, not a second when it reaches the connection", async () => {
    const { module } = fakeMysql2();
    const { recorder, spans } = fakeRecorder();
    patchMysql2(module, recorder);

    const command = new module.Pool().execute(
      "UPDATE jobs SET state = 'done'",
      [],
      vi.fn(),
    );
    await Promise.resolve();

    expect(spans).toHaveLength(1);
    command.onResult(null, []);
    expect(spans[0].ended).toBe(1);
  });

  it("keeps the span open until the callback when the call returns no command, as a real pool's execute() does", () => {
    const { recorder, spans } = fakeRecorder();
    let deliver: ((error: unknown, rows?: unknown) => void) | undefined;
    class Pool {
      execute(_sql: string, _values: unknown, callback: typeof deliver) {
        deliver = callback;
      }
    }
    patchMysql2({ Pool }, recorder);
    const callback = vi.fn();

    new Pool().execute("SELECT nope FROM missing", [], callback);
    expect(spans[0].ended).toBe(0);

    const failure = new Error("prepare failed");
    deliver?.(failure);
    expect(spans[0]).toMatchObject({ ended: 1, error: failure });
    expect(callback).toHaveBeenCalledWith(failure);
  });

  it("ends a streamed query on `end`, and adds no error listener", () => {
    const { module, commands } = fakeMysql2();
    const { recorder, spans } = fakeRecorder();
    patchMysql2(module, recorder);

    new module.Connection().query("SELECT 1");
    expect(commands[0].listenerCount("error")).toBe(0);
    commands[0].emit("end");
    expect(spans[0].ended).toBe(1);
  });
});

/**
 * A recorder whose `cover` is the real thing, an async context, and which
 * opens spans only where `record` says - so a callback that runs in another
 * request's context shows, and so does a checkout that loses the cover.
 */
const contextRecorder = (record = true) => {
  const covered = new AsyncLocalStorage<true>();
  const spans: Array<{ methodKey: string; ended: number }> = [];
  const recorder = {
    open: (_className: string, methodKey: string) => {
      if (!record || covered.getStore()) {
        return undefined;
      }
      const span = { methodKey, ended: 0 };
      spans.push(span);
      return { end: () => (span.ended += 1) };
    },
    cover: <T>(fn: () => T) => covered.run(true, fn),
    endWhenSettled: OutgoingSpanRecorder.prototype.endWhenSettled,
  } as unknown as OutgoingSpanRecorder;
  return { recorder, spans };
};

/** Whose request a callback runs in, as the application's own stores see it. */
const request = new AsyncLocalStorage<string>();

describe("patchPg", () => {
  /**
   * pg's shape: a client answers from its socket, and a pool hands a queued
   * checkout over from whichever call releases a client.
   */
  const fakePg = () => {
    const answers: Array<() => void> = [];
    const pending: Array<(error: unknown, client: unknown) => void> = [];
    class Client {
      query(_text: unknown, _values: unknown, callback: any) {
        answers.push(() => callback(null, { rows: [] }));
      }
    }
    class Pool {
      client = new Client();
      connect(callback: (error: unknown, client: unknown) => void) {
        pending.push(callback);
      }
      query(text: unknown, values: unknown, callback: any) {
        this.connect((_error, client: any) =>
          client.query(text, values, callback),
        );
      }
      release() {
        pending.shift()?.(null, this.client);
      }
    }
    return { module: { Client, Pool }, answers };
  };

  it.each([true, false])(
    "runs a query callback in its caller's context, recorded=%s",
    (record) => {
      const { module, answers } = fakePg();
      patchPg(module, contextRecorder(record).recorder);
      let seen: string | undefined;

      request.run("caller", () =>
        new module.Client().query("SELECT 1", [], () => {
          seen = request.getStore();
        }),
      );
      request.run("socket", () => answers.shift()!());

      expect(seen).toBe("caller");
    },
  );

  it("hands a queued checkout to the caller's context, where the pool's span covers it", () => {
    const { module, answers } = fakePg();
    const { recorder, spans } = contextRecorder();
    patchPg(module, recorder);
    const pool = new module.Pool();
    let seen: string | undefined;

    request.run("caller", () =>
      pool.query("SELECT * FROM products", [], () => {
        seen = request.getStore();
      }),
    );
    request.run("releaser", () => pool.release());
    request.run("socket", () => answers.shift()!());

    expect(spans).toEqual([{ methodKey: "SELECT products", ended: 1 }]);
    expect(seen).toBe("caller");
  });
});

describe("patchPg with a config object", () => {
  /** A tagged-template statement: `text` is a getter on its class. */
  class Statement {
    values = [1];
    get text() {
      return "SELECT * FROM plans WHERE id = $1";
    }
  }

  const fakePg = () => {
    const texts: unknown[] = [];
    class Client {
      query(config: any, _values?: unknown, callback?: any) {
        texts.push(config.text);
        const answer = callback ?? config.callback;
        if (answer) {
          queueMicrotask(() => answer(null, { rows: [] }));
          return undefined;
        }
        return Promise.resolve({ rows: [] });
      }
    }
    class Pool {
      // pg-pool answers through its promise, and hands the client a callback
      // of its own - which pg then stores on the config object.
      query(config: any) {
        texts.push(config.text);
        config.callback = () => undefined;
        return Promise.resolve({ rows: [] });
      }
    }
    return { module: { Client, Pool }, texts };
  };

  it("runs a statement object through a pool twice, its text and span intact", async () => {
    const { module, texts } = fakePg();
    const { recorder, spans } = fakeRecorder();
    patchPg(module, recorder);
    const pool = new module.Pool();
    const statement = new Statement();

    await pool.query(statement);
    // Now carrying the pool's own callback, which nothing calls again.
    await pool.query(statement);

    expect(texts).toEqual([statement.text, statement.text]);
    expect(spans.map((span) => span.ended)).toEqual([1, 1]);
  });

  it("keeps a statement object's text when the client is given its callback on it", async () => {
    const { module, texts } = fakePg();
    const { recorder, spans } = fakeRecorder();
    patchPg(module, recorder);
    const answered = vi.fn();
    const statement = Object.assign(new Statement(), { callback: answered });

    new module.Client().query(statement);
    await Promise.resolve();

    expect(texts).toEqual([statement.text]);
    expect(answered).toHaveBeenCalledTimes(1);
    expect(spans[0].ended).toBe(1);
    expect(statement.callback).toBe(answered);
  });
});

describe("patchMysql2 async context", () => {
  /** mysql2's shape, with the pool's checkout queue. */
  const fakeMysql2 = () => {
    const commands: any[] = [];
    const pending: Array<(error: unknown, connection: unknown) => void> = [];
    class Connection {
      execute(sql: unknown, _values: unknown, callback: any) {
        const command = { sql, onResult: callback };
        commands.push(command);
        return command;
      }
    }
    class Pool {
      connection = new Connection();
      getConnection(callback: (error: unknown, connection: unknown) => void) {
        pending.push(callback);
      }
      execute(sql: string, values: unknown, callback: any) {
        this.getConnection((_error, connection: any) =>
          connection.execute(sql, values, callback),
        );
      }
      release() {
        pending.shift()?.(null, this.connection);
      }
    }
    return { module: { Connection, Pool }, commands };
  };

  it.each([true, false])(
    "runs a query callback in its caller's context, recorded=%s",
    (record) => {
      const { module, commands } = fakeMysql2();
      patchMysql2(module, contextRecorder(record).recorder);
      let seen: string | undefined;

      request.run("caller", () =>
        new module.Connection().execute("SELECT 1", [], () => {
          seen = request.getStore();
        }),
      );
      request.run("socket", () => commands[0].onResult(null, []));

      expect(seen).toBe("caller");
    },
  );

  it("hands a queued checkout to the caller's context, where the pool's span covers it", () => {
    const { module, commands } = fakeMysql2();
    const { recorder, spans } = contextRecorder();
    patchMysql2(module, recorder);
    const pool = new module.Pool();
    let seen: string | undefined;

    request.run("caller", () =>
      pool.execute("INSERT INTO subscribers (email) VALUES (?)", [], () => {
        seen = request.getStore();
      }),
    );
    request.run("releaser", () => pool.release());
    request.run("socket", () => commands[0].onResult(null, []));

    expect(spans).toEqual([{ methodKey: "INSERT subscribers", ended: 1 }]);
    expect(seen).toBe("caller");
  });
});

describe("patchMongodb", () => {
  it("names the command and collection, and ships the shape without the values", () => {
    expect(
      describeMongoCommand({
        find: "users",
        filter: {
          email: "a@b.co",
          age: { $gt: 21 },
          tags: { $in: ["x", "y"] },
        },
        limit: 10,
        lsid: { id: "session" },
        $db: "app",
      }),
    ).toEqual({
      operation: "find users",
      statement:
        '{"find":"users","filter":{"email":"?","age":{"$gt":"?"},"tags":{"$in":["?"]}},"limit":"?"}',
    });
  });

  it("settles the span with the command's promise, and leaves the promise alone", async () => {
    class Connection {
      async command(_ns: unknown, command: { fail?: boolean }) {
        if (command.fail) {
          throw new Error("not primary");
        }
        return { ok: 1 };
      }
    }
    const { recorder, spans } = fakeRecorder();
    patchMongodb({ Connection }, recorder);

    await expect(
      new Connection().command("app.$cmd", { find: "users" } as never),
    ).resolves.toEqual({ ok: 1 });
    await expect(
      new Connection().command("app.$cmd", {
        insert: "users",
        fail: true,
      } as never),
    ).rejects.toThrow("not primary");

    expect(spans.map((span) => [span.methodKey, span.ended])).toEqual([
      ["find users", 1],
      ["insert users", 1],
    ]);
    expect(spans[1].error).toBeInstanceOf(Error);
  });

  it("ends the span at once when the driver hands back something it cannot wait on", () => {
    class Connection {
      command() {
        return undefined;
      }
    }
    const { recorder, spans } = fakeRecorder();
    patchMongodb({ Connection }, recorder);

    (new Connection().command as any)("app.$cmd", { find: "users" });
    expect(spans[0].ended).toBe(1);
  });

  it("leaves the driver's own housekeeping unrecorded", async () => {
    class Connection {
      async command() {
        return { ok: 1 };
      }
    }
    const { recorder, spans } = fakeRecorder();
    patchMongodb({ Connection }, recorder);

    for (const name of [
      "hello",
      "ismaster",
      "saslStart",
      "ping",
      "endSessions",
    ]) {
      await (new Connection().command as any)("admin.$cmd", { [name]: 1 });
    }

    expect(spans).toHaveLength(0);
  });

  it("keeps every stage of a pipeline and every branch of an $or, but one of a list of values", () => {
    const { statement } = describeMongoCommand({
      aggregate: "orders",
      pipeline: [
        {
          $match: {
            $or: [{ total: { $gt: 5 } }, { sku: { $in: ["a", "b", "c"] } }],
          },
        },
        { $group: { _id: "$sku", sum: { $sum: "$total" } } },
        { $sort: { sum: -1 } },
      ],
    });

    expect(JSON.parse(statement).pipeline).toEqual([
      { $match: { $or: [{ total: { $gt: "?" } }, { sku: { $in: ["?"] } }] } },
      { $group: { _id: "?", sum: { $sum: "?" } } },
      { $sort: { sum: "?" } },
    ]);
  });
});
