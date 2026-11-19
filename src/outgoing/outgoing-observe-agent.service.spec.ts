import { AsyncLocalStorage } from "node:async_hooks";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { OutgoingObserveAgentService } from "./outgoing-observe-agent.service.js";

/** A driver module reduced to the classes whose prototypes get patched. */
type DriverCopy = Record<string, { prototype: object }>;

const nested = vi.hoisted(() => {
  const pg = () => ({
    Client: class {
      query() {}
    },
    Pool: class {
      query() {}
    },
  });
  const mysql2 = () => ({
    Connection: class {
      query() {}
      execute() {}
    },
    Pool: class {
      query() {}
      execute() {}
    },
  });
  const mongodb = () => ({
    Connection: class {
      command() {}
    },
  });
  const drivers = [
    {
      driver: "pg",
      specifier: "pg",
      copy: pg,
      methods: ["query"],
      dependents: [
        "pg-promise",
        "@slonik/pg-driver",
        "@databases/pg",
        "pg-boss",
        "graphile-worker",
        "connect-pg-simple",
        "@keyv/postgres",
        "@socket.io/postgres-adapter",
      ],
    },
    {
      driver: "mysql2",
      specifier: "mysql2",
      copy: mysql2,
      methods: ["query", "execute"],
      dependents: ["serverless-mysql", "express-mysql-session", "@keyv/mysql"],
    },
    {
      driver: "mongodb",
      specifier: "mongodb/lib/cmap/connection",
      copy: mongodb,
      methods: ["command"],
      dependents: ["@hokify/agenda", "connect-mongodb-session", "@keyv/mongo"],
    },
  ];
  return {
    resolvedBy: [] as Array<[string, string]>,
    /** The `pg` copy npm nests inside Prisma's pg adapter on a version clash. */
    pg: pg(),
    /** The `Request` of the `mssql` npm nests inside Prisma's SQL Server adapter. */
    mssql: class {
      _query() {}
      _execute() {}
    },
    /** Packages beyond the ORMs, each with a driver copy of its own. */
    beyondOrms: drivers.flatMap(({ dependents, copy, ...driver }) =>
      dependents.map((dependent) => ({
        ...driver,
        dependent,
        copy: copy() as DriverCopy,
      })),
    ),
  };
});

// No driver is the application's own here, so whatever gets patched is a
// copy found through a package that depends on the driver directly.
vi.mock("../utils/optional-peer.util.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/optional-peer.util.js")>();
  const copies = new Map<string, unknown>([
    ["@prisma/adapter-pg", nested.pg],
    ["@prisma/adapter-mssql", nested.mssql],
    ...nested.beyondOrms.map(
      ({ dependent, copy }) => [dependent, copy] as [string, unknown],
    ),
  ]);
  return {
    ...original,
    loadOptionalPeer: () => ({ installed: false }),
    loadAsResolvedBy: (dependent: string, specifier: string) => {
      nested.resolvedBy.push([dependent, specifier]);
      return copies.get(dependent);
    },
  };
});

const isPatched = (prototype: object, method: string) =>
  Object.hasOwn(prototype, Symbol.for(`nestjs.observe.original.${method}`));

describe("OutgoingObserveAgentService", () => {
  beforeAll(() => {
    const storage = new AsyncLocalStorage<Map<any, any>>();
    const service = new OutgoingObserveAgentService(
      {
        outgoing: { http: false },
        traceIdKey: "traceId",
      } as ObserveModuleOptionsWithDefaults,
      new OperationTraceRegistry(storage, false),
      storage,
    );
    service.onApplicationShutdown();
  });

  it("patches the pg copy that Prisma's pg adapter resolves", () => {
    expect(nested.resolvedBy).toContainEqual(["@prisma/adapter-pg", "pg"]);
    for (const { prototype } of [nested.pg.Client, nested.pg.Pool]) {
      expect(isPatched(prototype, "query")).toBe(true);
    }
  });

  it("patches the mssql copy that Prisma's SQL Server adapter resolves", () => {
    expect(nested.resolvedBy).toContainEqual([
      "@prisma/adapter-mssql",
      "mssql/lib/tedious/request",
    ]);
    for (const method of ["_query", "_execute"]) {
      expect(isPatched(nested.mssql.prototype, method)).toBe(true);
    }
  });

  it.each(nested.beyondOrms.map((c) => [c.driver, c.dependent, c] as const))(
    "patches the %s copy that %s resolves",
    (_driver, dependent, { specifier, copy, methods }) => {
      expect(nested.resolvedBy).toContainEqual([dependent, specifier]);
      for (const { prototype } of Object.values(copy)) {
        for (const method of methods) {
          expect(isPatched(prototype, method)).toBe(true);
        }
      }
    },
  );
});
