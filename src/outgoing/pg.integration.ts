import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchMethod } from "./patch-method.util.js";
import { describeSqlStatement } from "./sql-statement.util.js";

interface PgModule {
  Client?: { prototype?: object };
  Pool?: { prototype?: object };
}

/**
 * Query spans for `pg` - and so for everything built on it: TypeORM,
 * MikroORM, Knex, Drizzle, Sequelize, and Prisma through its pg adapter.
 *
 * Both entry points are patched. `Client#query` is the one every query ends
 * up in; `Pool#query` is patched as well because it reaches the client from
 * inside the pool's checkout callback, which for a queued checkout runs in
 * whichever request released the connection - the span has to be opened
 * before that hop, in the caller's own context. The pool's span then covers
 * the client call it leads to.
 */
export function patchPg(pg: PgModule, recorder: OutgoingSpanRecorder): boolean {
  const wrap = (covers: boolean) => (original: (...args: any[]) => any) =>
    function (this: unknown, ...args: any[]) {
      const config = args[0];
      const text: unknown = typeof config === "string" ? config : config?.text;
      // A submittable - a cursor, a query stream - reports completion
      // through its own events rather than a callback or a promise.
      if (typeof text !== "string" || typeof config?.submit === "function") {
        return original.apply(this, args);
      }
      const { operation, statement } = describeSqlStatement(text);
      const span = recorder.open("pg", operation, {
        "db.system": "postgresql",
        "db.statement": statement,
      });
      if (!span) {
        return original.apply(this, args);
      }

      let hasCallback = false;
      const last = args.length - 1;
      if (typeof args[last] === "function") {
        const callback = args[last];
        hasCallback = true;
        args[last] = function (this: unknown, error: unknown, ...rest: any[]) {
          span.end(error);
          return callback.call(this, error, ...rest);
        };
      } else if (typeof config?.callback === "function") {
        const callback = config.callback;
        hasCallback = true;
        args[0] = {
          ...config,
          callback(this: unknown, error: unknown, ...rest: any[]) {
            span.end(error);
            return callback.call(this, error, ...rest);
          },
        };
      }

      try {
        const result = covers
          ? recorder.cover(() => original.apply(this, args))
          : original.apply(this, args);
        return hasCallback ? result : recorder.endWhenSettled(span, result);
      } catch (error) {
        span.end(error);
        throw error;
      }
    };

  const client = patchMethod(pg.Client?.prototype, "query", wrap(false));
  const pool = patchMethod(pg.Pool?.prototype, "query", wrap(true));
  return client || pool;
}
