import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OBSERVE_OPTIONS, TRACE_CONTEXT_KEY } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import {
  loadAsResolvedBy,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";
import type { TraceContext } from "../utils/trace-context.util.js";
import { subscribeOutgoingHttp } from "./http.integration.js";
import {
  activateLlmFetchObserver,
  llmCallsOff,
  uninstallLlmFetchObserver,
} from "./llm/llm-fetch.integration.js";
import { patchMongodb } from "./mongodb.integration.js";
import { patchMssql } from "./mssql.integration.js";
import { patchMysql2 } from "./mysql2.integration.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchPg } from "./pg.integration.js";

/**
 * Spans for what leaves the process: database queries and outbound HTTP.
 *
 * The drivers are instrumented, not the ORMs. Every ORM a Nest application is
 * likely to use ends in a supported driver, so small patches cover
 * TypeORM, MikroORM, Prisma's driver adapters, Mongoose, Knex, Drizzle and
 * Sequelize alike, and none of them has to be known by name. Each driver is an
 * optional peer nobody is asked to install: it is looked up, and patched only
 * if the application already has it.
 */
/**
 * Packages that list a driver under `dependencies` rather than
 * `peerDependencies`.
 *
 * A peer resolves to the application's own copy, which is the one patched. A
 * direct dependency does too - until the versions disagree, and npm nests a
 * private copy inside the ORM. MikroORM pins its drivers to exact versions,
 * so that happens on a single patch release of difference (its `mysql2`
 * 3.24.3 beside an application's 3.24.4); Mongoose asks for a minor range.
 * Queries through the ORM would then run on a copy nobody patched and simply
 * not appear, with nothing to say why. Prisma's driver adapters depend on
 * their drivers directly too: the pg adapter has since 6.11 and asks for
 * ^8.16.3, and the SQL Server adapter asks for `mssql` ^12.2, so an
 * application pinned outside those ranges runs Prisma's queries on a nested
 * copy.
 *
 * The same holds beyond the ORMs, for packages that reach the database on
 * the application's behalf: query libraries, job queues, session stores,
 * Keyv's cache stores and Socket.IO's Postgres adapter. pg-promise and
 * express-mysql-session pin their driver exactly, and @hokify/agenda still
 * asks for `mongodb` 4. What they run inside a request is recorded whenever
 * they share the application's copy, so a nested copy is followed too; a
 * queue's own polling runs outside any trace and records nothing either way.
 *
 * TypeORM, Drizzle, Knex and Sequelize take their driver as a peer and need
 * no entry.
 */
const DRIVER_DEPENDENTS = {
  pg: [
    "@mikro-orm/postgresql",
    "@prisma/adapter-pg",
    "pg-promise",
    "@slonik/pg-driver",
    "@databases/pg",
    "pg-boss",
    "graphile-worker",
    "connect-pg-simple",
    "@keyv/postgres",
    "@socket.io/postgres-adapter",
  ],
  mysql2: [
    "@mikro-orm/mysql",
    "serverless-mysql",
    "express-mysql-session",
    "@keyv/mysql",
  ],
  mongodb: [
    "mongoose",
    "@mikro-orm/mongodb",
    "@hokify/agenda",
    "connect-mongodb-session",
    "@keyv/mongo",
  ],
  mssql: ["@prisma/adapter-mssql"],
} as const;

@Injectable()
export class OutgoingObserveAgentService implements OnApplicationShutdown {
  private readonly logger = new Logger(OutgoingObserveAgentService.name);
  private unsubscribeHttp?: () => void;
  private deactivateLlm?: () => void;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    operationTraceRegistry: OperationTraceRegistry,
    asyncLocalStorage: AsyncLocalStorage<Map<any, any>>,
  ) {
    const outgoing = this.options.outgoing;
    // `forRoot` has given `fetch` back already; `forRootAsync` options are
    // only known from here.
    if (llmCallsOff(outgoing)) {
      uninstallLlmFetchObserver();
    }
    if (outgoing === false) {
      return;
    }
    const recorder = new OutgoingSpanRecorder(
      operationTraceRegistry,
      asyncLocalStorage,
      this.options.traceIdKey,
    );

    if (outgoing?.database !== false) {
      this.patchDriver("pg", "pg", DRIVER_DEPENDENTS.pg, (module) =>
        patchPg(module, recorder),
      );
      this.patchDriver("mysql2", "mysql2", DRIVER_DEPENDENTS.mysql2, (module) =>
        patchMysql2(module, recorder),
      );
      this.patchDriver(
        "mongodb",
        "mongodb/lib/cmap/connection",
        DRIVER_DEPENDENTS.mongodb,
        (module) => patchMongodb(module, recorder),
      );
      this.patchDriver("mssql", "mssql", DRIVER_DEPENDENTS.mssql, (module) =>
        patchMssql(module, recorder),
      );
    }

    if (outgoing?.http !== false) {
      const http = typeof outgoing?.http === "object" ? outgoing.http : {};
      this.unsubscribeHttp = subscribeOutgoingHttp(
        recorder,
        () => {
          const store = asyncLocalStorage.getStore();
          const traceId: unknown = store?.get(this.options.traceIdKey);
          if (typeof traceId !== "string") {
            return undefined;
          }
          const traceContext = store?.get(TRACE_CONTEXT_KEY) as
            | TraceContext
            | undefined;
          return { traceId, traceContext };
        },
        {
          ...http,
          // W3C Trace Context goes out only with `openTelemetry` on.
          traceContext:
            this.options.openTelemetry === true && http.traceContext !== false,
        },
        () => operationTraceRegistry.getRedactor(),
      );
      // Model calls are read off the spans above, so they go with them.
      if (outgoing?.llm !== false) {
        this.deactivateLlm = activateLlmFetchObserver(
          recorder,
          typeof outgoing?.llm === "object" ? outgoing.llm : {},
        );
      }
    }
  }

  onApplicationShutdown() {
    this.deactivateLlm?.();
    this.unsubscribeHttp?.();
  }

  /**
   * Patches every copy of a driver the application can end up running on: the
   * one it resolves itself, and the one each ORM that depends on the driver
   * *directly* resolves - see `DRIVER_DEPENDENTS`.
   */
  private patchDriver(
    packageName: string,
    specifier: string,
    dependents: readonly string[],
    patch: (module: any) => boolean,
  ) {
    const copies: unknown[] = [];
    const own = loadOptionalPeer<unknown>(packageName, specifier);
    if (own.installed && own.module) {
      copies.push(own.module);
    }
    for (const dependent of dependents) {
      const theirs = loadAsResolvedBy<unknown>(dependent, specifier);
      if (theirs && !copies.includes(theirs)) {
        copies.push(theirs);
      }
    }
    if (copies.length === 0) {
      return;
    }

    // Never fatal, and quiet unless asked: a driver that moved its internals
    // costs the query spans, and the application did nothing wrong.
    let patched = false;
    for (const copy of copies) {
      try {
        patched = patch(copy) || patched;
      } catch {
        /* reported below */
      }
    }
    if (!patched && this.options.debug) {
      this.logger.debug(
        `${packageName} is installed but could not be instrumented, so its queries will not appear as spans.`,
      );
    }
  }
}
