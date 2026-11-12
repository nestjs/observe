import { AsyncResource } from "node:async_hooks";
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
 * before that hop, in the caller's own context. `Pool#connect` hands the
 * checkout back to that context, so the pool's span covers the client call
 * it leads to.
 */
export function patchPg(pg: PgModule, recorder: OutgoingSpanRecorder): boolean {
  const wrap = (covers: boolean) => (original: (...args: any[]) => any) =>
    function (this: unknown, ...args: any[]) {
      const last = args.length - 1;
      // pg answers from the connection's socket, whose events fire in the
      // context of the call that opened it - another request's. Bound first,
      // so a call that is not recorded keeps its own context too.
      if (typeof args[last] === "function") {
        args[last] = AsyncResource.bind(args[last]);
      }
      const config = args[0];
      const text: unknown = typeof config === "string" ? config : config?.text;
      // A submittable - a cursor, a query stream - reports completion
      // through its own events rather than a callback or a promise.
      if (typeof text !== "string" || typeof config?.submit === "function") {
        return original.apply(this, args);
      }
      const { operation, statement } = describeSqlStatement(text, "postgresql");
      const span = recorder.open("pg", operation, {
        "db.system": "postgresql",
        "db.statement": statement,
      });
      if (!span) {
        return original.apply(this, args);
      }

      let hasCallback = false;
      if (typeof args[last] === "function") {
        const callback = args[last];
        hasCallback = true;
        args[last] = function (this: unknown, error: unknown, ...rest: any[]) {
          span.end(error);
          return callback.call(this, error, ...rest);
        };
      } else if (!covers && typeof config?.callback === "function") {
        // Only a client calls a config's `callback`. A pool answers through
        // its promise and hands the client a callback of its own, which pg
        // stores on the config: one a pool has run before carries a
        // `callback` that is not the caller's, and that nothing calls again.
        const callback = AsyncResource.bind(config.callback);
        hasCallback = true;
        // Derived from the caller's config rather than copied from it: a
        // statement object (sql-template-tag, sql-template-strings) keeps
        // `text` on its prototype, where a spread does not reach.
        args[0] = Object.create(config, {
          callback: {
            value(this: unknown, error: unknown, ...rest: any[]) {
              span.end(error);
              return callback.call(this, error, ...rest);
            },
            writable: true,
            enumerable: true,
            configurable: true,
          },
        });
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
  // A queued checkout is handed its client by whichever call releases one:
  // bound, it runs where it was asked for - under the pool's span and its
  // cover, or under no trace at all - not in the releasing request.
  patchMethod(
    pg.Pool?.prototype,
    "connect",
    (original) =>
      function (this: unknown, ...args: any[]) {
        if (typeof args[0] === "function") {
          args[0] = AsyncResource.bind(args[0]);
        }
        return original.apply(this, args);
      },
  );
  return client || pool;
}
