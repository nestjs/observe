import { Controller, Get, Injectable, Module, Query } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import mysql from "mysql2";
import mysqlPromise from "mysql2/promise";
import { connect } from "net";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const MYSQL = {
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "root",
  database: process.env.MYSQL_DATABASE ?? "test",
};

const mysqlReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: MYSQL.host, port: MYSQL.port });
  const finish = (up: boolean) => {
    socket.destroy();
    resolve(up);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const { ObserveModule, ObserveInstrument } = createObserveModule();

let callbackPool: mysql.Pool;
let promisePool: mysqlPromise.Pool;
let promiseConnection: mysqlPromise.Connection;

@Injectable()
class WarehouseService {
  callbackPoolQuery() {
    return new Promise((resolve, reject) =>
      callbackPool.query("SELECT ? AS sku", ["a-1"], (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
  }

  callbackPoolExecute() {
    return new Promise((resolve, reject) =>
      callbackPool.execute("SELECT ? AS sku", ["a-2"], (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
  }

  callbackPoolFailing() {
    return new Promise((resolve) =>
      callbackPool.query("SELECT nope FROM missing_table_observe", (error) =>
        resolve(error?.message),
      ),
    );
  }

  async poolExecuteSlow() {
    await promisePool.execute("SELECT SLEEP(?) AS slept", [0.08]);
  }

  async poolExecuteFailing() {
    await promisePool.execute("SELECT nope FROM missing_table_observe");
  }

  async connectionExecute() {
    const [rows] = await promiseConnection.execute("SELECT ? AS bound", [
      "bound-secret-value",
    ]);
    return rows;
  }

  async connectionExecuteFailing() {
    await promiseConnection.execute("SELECT nope FROM missing_table_observe");
  }

  async optionsObject() {
    await promisePool.query({
      sql: "SELECT ? AS via_options",
      values: ["options-secret-value"],
    });
    await promisePool.execute({
      sql: "SELECT ? AS via_execute_options",
      values: ["options-secret-value"],
      rowsAsArray: true,
    });
  }

  async interpolated() {
    await promisePool.query(
      "SELECT 'literal-secret' AS s, 4242424242 AS n /* comment-secret */ FROM DUAL WHERE 1 IN (1, 2, 3)",
    );
  }

  async checkedOutConnection() {
    const connection = await promisePool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("SELECT ? AS inside", [1]);
      await connection.rollback();
    } finally {
      connection.release();
    }
  }

  callbackCheckedOut() {
    return new Promise<void>((resolve, reject) =>
      callbackPool.getConnection((checkoutError, connection) => {
        if (checkoutError) {
          return reject(checkoutError);
        }
        connection.query("SELECT 1 AS one", (error) => {
          connection.release();
          return error ? reject(error) : resolve();
        });
      }),
    );
  }
}

@Controller()
class WarehouseController {
  constructor(private readonly warehouse: WarehouseService) {}

  @Get("run")
  async run(@Query("scenario") scenario: string) {
    const method = (this.warehouse as unknown as Record<string, unknown>)[
      scenario
    ] as () => Promise<unknown>;
    let failure: string | undefined;
    const result = await method
      .call(this.warehouse)
      .catch((error: Error) => void (failure = error.message));
    return { result, failure };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [WarehouseController],
  providers: [WarehouseService],
})
class Mysql2ScenariosModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

/**
 * `mysql2` by its other doors: the callback pool, `execute` on a bare
 * connection, the options-object form, a checked-out connection.
 *
 * The driver suite proves the promise pool and a bare callback connection.
 * What differs here is who builds the command and who is handed it - a
 * callback pool's `execute` passes the SQL string on to a connection's
 * `execute`, a promise wrapper calls the core connection underneath - and
 * each hand-over is a place where one query could be recorded twice, or not
 * at all.
 */
describe.skipIf(!mysqlReachable)("ObserveModule: mysql2 scenarios", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      Mysql2ScenariosModule,
      { instrument: ObserveInstrument, logger: false },
    );
    collected = collectSnapshots(app);
    await app.init();

    // After the app: the agent patches the driver from its constructor.
    callbackPool = mysql.createPool({ ...MYSQL, connectionLimit: 2 });
    promisePool = mysqlPromise.createPool({ ...MYSQL, connectionLimit: 2 });
    promiseConnection = await mysqlPromise.createConnection(MYSQL);
  });

  afterAll(async () => {
    await promiseConnection?.end().catch(() => undefined);
    await promisePool?.end().catch(() => undefined);
    await new Promise((resolve) => callbackPool?.end(resolve));
    await app?.close();
  });

  beforeEach(() => collected.clear());

  const run = async (scenario: string) => {
    const response = await request(app.getHttpServer())
      .get("/run")
      .query({ scenario })
      .expect(200);
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/run",
    );
    const [service] = spansOf(
      snapshot.traces as CompleteTraceEventNode[],
      "WarehouseService",
    );
    return {
      body: response.body as { result?: unknown; failure?: string },
      snapshot,
      service,
      spans: spansOf(service.children, "mysql2"),
    };
  };

  it("records a callback-pool query once, and still calls back with the rows", async () => {
    const { body, spans } = await run("callbackPoolQuery");

    expect(body.result).toEqual([{ sku: "a-1" }]);
    expect(spans).toHaveLength(1);
    expect(spans[0].tags?.["db.statement"]).toBe("SELECT ? AS sku");
    expect(spans[0].error).toBeUndefined();
  });

  it("records a callback-pool execute() once, not again when the pool hands the SQL to a connection", async () => {
    const { body, snapshot, spans } = await run("callbackPoolExecute");

    expect(body.result).toEqual([{ sku: "a-2" }]);
    expect(spans).toHaveLength(1);
    expect(
      spansOf(snapshot.traces as CompleteTraceEventNode[], "mysql2"),
    ).toHaveLength(1);
  });

  it("marks a callback-pool query that failed, and hands the callback its error", async () => {
    const { body, spans } = await run("callbackPoolFailing");

    expect(String(body.result)).toContain("missing_table_observe");
    expect(spans).toHaveLength(1);
    expect(spans[0].error).toBeTruthy();
  });

  it("times a pool execute() to its result, not to the moment the pool queued it", async () => {
    // A pool's `execute` returns nothing - the command is built later, on the
    // connection it checks out - so the callback is the only end it has.
    const { spans } = await run("poolExecuteSlow");

    expect(spans).toHaveLength(1);
    expect(spans[0].duration).toBeGreaterThanOrEqual(70);
  });

  it("marks a pool execute() whose prepare failed", async () => {
    const { body, spans } = await run("poolExecuteFailing");

    expect(body.failure).toContain("missing_table_observe");
    expect(spans).toHaveLength(1);
    expect(spans[0].error).toBeTruthy();
  });

  it("records execute() on a bare promise connection once, without the bound value", async () => {
    const { snapshot, spans } = await run("connectionExecute");

    expect(spans).toHaveLength(1);
    expect(spans[0].tags).toEqual({
      "db.system": "mysql",
      "db.statement": "SELECT ? AS bound",
    });
    expect(JSON.stringify(snapshot)).not.toContain("bound-secret-value");
  });

  it("marks a failed execute(), and the caller still sees the driver's rejection", async () => {
    const { body, service, spans } = await run("connectionExecuteFailing");

    expect(body.failure).toContain("missing_table_observe");
    expect(service.error).toBeTruthy();
    expect(spans).toHaveLength(1);
    expect(spans[0].methodKey).toBe("SELECT missing_table_observe");
    expect(spans[0].error).toBeTruthy();
  });

  it("reads the SQL of an options object, for query() and execute(), and never its values", async () => {
    const { snapshot, spans } = await run("optionsObject");

    expect(spans.map((span) => span.tags?.["db.statement"])).toEqual([
      "SELECT ? AS via_options",
      "SELECT ? AS via_execute_options",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("options-secret-value");
  });

  it("strips the literals and comments an application interpolated", async () => {
    const { snapshot, spans } = await run("interpolated");

    expect(spans).toHaveLength(1);
    const everything = JSON.stringify(snapshot);
    for (const secret of ["literal-secret", "4242424242", "comment-secret"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("records a rolled-back transaction on a checked-out promise connection, statement by statement", async () => {
    const { spans } = await run("checkedOutConnection");

    expect(spans.map((span) => span.methodKey)).toEqual([
      "START",
      "SELECT",
      "ROLLBACK",
    ]);
  });

  it("records a query on a connection checked out of a callback pool", async () => {
    const { spans } = await run("callbackCheckedOut");

    expect(spans.map((span) => span.methodKey)).toEqual(["SELECT"]);
  });

  it("records query spans as leaves, origin auto", async () => {
    const { spans } = await run("callbackPoolQuery");

    expect(spans[0].origin).toBe("auto");
    expect(spans[0].children).toBeUndefined();
  });

  it("runs queries issued outside any trace untouched, and reports nothing for them", async () => {
    const [rows] = await promisePool.query("SELECT 1 AS one");
    const viaCallback = await new Promise((resolve, reject) =>
      callbackPool.execute("SELECT 2 AS two", (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
    await expect(
      promisePool.query("SELECT nope FROM missing_table_observe"),
    ).rejects.toThrow(/missing_table_observe/);

    expect(rows).toEqual([{ one: 1 }]);
    expect(viaCallback).toEqual([{ two: 2 }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(collected.items).toEqual([]);
  });
});
