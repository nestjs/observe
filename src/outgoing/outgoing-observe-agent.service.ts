import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import {
  loadAsResolvedBy,
  loadOptionalPeer,
} from "../utils/optional-peer.util.js";
import { subscribeOutgoingHttp } from "./http.integration.js";
import { patchMongodb } from "./mongodb.integration.js";
import { patchMysql2 } from "./mysql2.integration.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";
import { patchPg } from "./pg.integration.js";

/**
 * Spans for what leaves the process: database queries and outbound HTTP.
 *
 * The drivers are instrumented, not the ORMs. Every ORM a Nest application is
 * likely to use ends in one of three drivers, so three small patches cover
 * TypeORM, MikroORM, Prisma's driver adapters, Mongoose, Knex, Drizzle and
 * Sequelize alike, and none of them has to be known by name. Each driver is an
 * optional peer nobody is asked to install: it is looked up, and patched only
 * if the application already has it.
 */
/**
 * ORMs that list a driver under `dependencies` rather than `peerDependencies`.
 *
 * A peer resolves to the application's own copy, which is the one patched. A
 * direct dependency does too - until the versions disagree, and npm nests a
 * private copy inside the ORM. MikroORM pins its drivers to exact versions,
 * so that happens on a single patch release of difference (its `mysql2`
 * 3.24.3 beside an application's 3.24.4); Mongoose asks for a minor range.
 * Queries through the ORM would then run on a copy nobody patched and simply
 * not appear, with nothing to say why.
 *
 * TypeORM, Drizzle, Knex, Sequelize and Prisma's adapters take their driver
 * as a peer and need no entry.
 */
const DRIVER_DEPENDENTS = {
  pg: ["@mikro-orm/postgresql"],
  mysql2: ["@mikro-orm/mysql"],
  mongodb: ["mongoose", "@mikro-orm/mongodb"],
} as const;

@Injectable()
export class OutgoingObserveAgentService implements OnApplicationShutdown {
  private readonly logger = new Logger(OutgoingObserveAgentService.name);
  private unsubscribeHttp?: () => void;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    operationTraceRegistry: OperationTraceRegistry,
    asyncLocalStorage: AsyncLocalStorage<Map<any, any>>,
  ) {
    const outgoing = this.options.outgoing;
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
    }

    if (outgoing?.http !== false) {
      this.unsubscribeHttp = subscribeOutgoingHttp(
        recorder,
        () => {
          const traceId: unknown = asyncLocalStorage
            .getStore()
            ?.get(this.options.traceIdKey);
          return typeof traceId === "string" ? traceId : undefined;
        },
        typeof outgoing?.http === "object" ? outgoing.http : {},
        () => operationTraceRegistry.getRedactor(),
      );
    }
  }

  onApplicationShutdown() {
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
