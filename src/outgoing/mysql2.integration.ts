import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import { describeSqlStatement } from "./sql-statement.util.js";

interface Mysql2Module {
  Connection?: { prototype?: object };
  Pool?: { prototype?: object };
}

/** Marks a command that already has a span, however it reaches a connection. */
const SPANNED = Symbol.for("nestjs.observe.mysql2.spanned");

interface Mysql2Command {
  sql?: unknown;
  onResult?: (error: unknown, ...rest: any[]) => unknown;
  once?: (event: string, listener: () => void) => unknown;
  [SPANNED]?: true;
}

/**
 * Query spans for `mysql2` - the core connection and pool, which the promise
 * wrappers, TypeORM, MikroORM, Knex, Drizzle and Sequelize all go through.
 *
 * A pool's `query` builds the command itself and hands that object to a
 * connection later, possibly from another request's context, so the span is
 * opened at the pool and the command is marked; the connection-level wrapper
 * sees the mark and stands aside.
 */
export function patchMysql2(
  mysql2: Mysql2Module,
  recorder: OutgoingSpanRecorder,
): boolean {
  const wrap = (original: (...args: any[]) => any) =>
    function (this: unknown, ...args: any[]) {
      const first: Mysql2Command | string | undefined = args[0];
      if (typeof first === "object" && first?.[SPANNED]) {
        return original.apply(this, args);
      }
      const sql = typeof first === "string" ? first : first?.sql;
      if (typeof sql !== "string") {
        return original.apply(this, args);
      }
      const { operation, statement } = describeSqlStatement(sql);
      const span = recorder.open("mysql2", operation, {
        "db.system": "mysql",
        "db.statement": statement,
      });
      if (!span) {
        return original.apply(this, args);
      }

      // The callback is wrapped where it is passed, not only once it has
      // become the command's `onResult`: a pool's `execute` returns no command
      // at all - it builds one later, on the connection it checks out - and a
      // connection's `execute` reports a failed prepare to the callback it
      // was given, whatever `onResult` has been replaced with since.
      let hasCallback = false;
      const last = args.length - 1;
      if (typeof args[last] === "function") {
        const callback = args[last];
        hasCallback = true;
        args[last] = function (this: unknown, error: unknown, ...rest: any[]) {
          span.end(error);
          return callback.call(this, error, ...rest);
        };
      }

      let command: Mysql2Command | undefined;
      try {
        // Covered as well as marked. The mark follows a command *object* to
        // the connection, which is how `pool.query` hands its work over; but
        // `pool.execute` passes the connection the SQL string again, with
        // nothing to carry a mark, and the same query would be recorded twice.
        command = recorder.cover(() => original.apply(this, args));
      } catch (error) {
        span.end(error);
        throw error;
      }
      if (!command || typeof command !== "object") {
        if (!hasCallback) {
          span.end();
        }
        return command;
      }
      command[SPANNED] = true;
      if (hasCallback) {
        return command;
      }
      if (typeof command.onResult === "function") {
        const onResult = command.onResult;
        command.onResult = function (this: unknown, error: unknown, ...rest) {
          span.end(error);
          return onResult.call(this, error, ...rest);
        };
      } else {
        // The streaming form. `end` always fires; an `error` listener is not
        // added, because without one mysql2 lets the error surface as an
        // uncaught exception, and an agent must not be what silences that.
        command.once?.("end", () => span.end());
      }
      return command;
    };

  const patched = ["query", "execute"].flatMap((method) => [
    patchMethod(mysql2.Connection?.prototype, method, wrap),
    patchMethod(mysql2.Pool?.prototype, method, wrap),
  ]);
  return patched.some(Boolean);
}
