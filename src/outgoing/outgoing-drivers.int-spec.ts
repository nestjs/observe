import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { MongoClient } from "mongodb";
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
const MONGO_HOST = process.env.MONGO_HOST ?? "127.0.0.1";
const MONGO_PORT = Number(process.env.MONGO_PORT ?? 27027);

const reachable = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const finish = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

/** Each driver's assertions run only where its server answers. */
const mysqlReachable = await reachable(MYSQL.host, MYSQL.port);
const mongoReachable = await reachable(MONGO_HOST, MONGO_PORT);

const { ObserveModule, ObserveInstrument } = createObserveModule();

let pool: mysqlPromise.Pool;
let callbackConnection: mysql.Connection;
let mongo: MongoClient;

@Injectable()
class StockService {
  async viaPromisePool() {
    const [rows] = await pool.query(
      "SELECT ? AS sku, 'secret-literal' AS note",
      ["a-1"],
    );
    return rows;
  }

  async viaExecute() {
    const [rows] = await pool.execute("SELECT ? + 1 AS next", [41]);
    return rows;
  }

  viaCallback() {
    return new Promise((resolve, reject) =>
      callbackConnection.query("SELECT 1 AS one", (error, rows) =>
        error ? reject(error) : resolve(rows),
      ),
    );
  }

  async failing() {
    await pool.query("SELECT nope FROM missing_table_observe");
  }

  async transaction() {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("SELECT 1 AS inside");
      await connection.commit();
    } finally {
      connection.release();
    }
  }

  streamed() {
    return new Promise<number>((resolve, reject) => {
      let rows = 0;
      callbackConnection
        .query("SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3")
        .on("result", () => (rows += 1))
        .on("error", reject)
        .on("end", () => resolve(rows));
    });
  }

  concurrent() {
    return Promise.all([
      pool.query("SELECT 'a' AS v"),
      pool.query("SELECT 'b' AS v"),
      pool.query("SELECT 'c' AS v"),
    ]);
  }

  async nPlusOne() {
    for (let id = 0; id < 30; id += 1) {
      await pool.query("SELECT ? AS id", [id]);
    }
  }

  async mongoCursorAndAggregate() {
    const orders = mongo.db("observe_int").collection("orders");
    await orders.insertMany(
      Array.from({ length: 5 }, (_, index) => ({
        sku: `sku-${index}`,
        total: index * 10,
      })),
    );
    await orders.find({ total: { $gte: 10 } }).toArray();
    await orders
      .aggregate([
        { $match: { total: { $gt: 0 } } },
        { $group: { _id: null, sum: { $sum: "$total" } } },
      ])
      .toArray();
    await orders.updateOne({ sku: "sku-1" }, { $set: { total: 99 } });
    await orders.deleteMany({ total: { $lt: 5 } });
    await orders.bulkWrite([
      { insertOne: { document: { sku: "bulk-1", total: 1 } } },
      {
        updateOne: { filter: { sku: "sku-2" }, update: { $inc: { total: 1 } } },
      },
    ]);
  }

  async mongoDuplicateKey() {
    const unique = mongo.db("observe_int").collection("unique_things");
    await unique.createIndex({ key: 1 }, { unique: true });
    await unique.insertOne({ key: "only-one" });
    await unique.insertOne({ key: "only-one" });
  }

  mongoConcurrent() {
    const things = mongo.db("observe_int").collection("things");
    return Promise.all([
      things.findOne({ a: 1 }),
      things.findOne({ b: 2 }),
      things.countDocuments({ c: 3 }),
    ]);
  }

  async mongoRoundTrip() {
    const users = mongo.db("observe_int").collection("users");
    await users.insertOne({ email: "kamil@example.com", age: 33 });
    return users.findOne({ email: "kamil@example.com", age: { $gt: 21 } });
  }
}

@Controller()
class StockController {
  constructor(private readonly stock: StockService) {}

  @Get("mysql/pool")
  pool() {
    return this.stock.viaPromisePool();
  }

  @Get("mysql/execute")
  execute() {
    return this.stock.viaExecute();
  }

  @Get("mysql/callback")
  callback() {
    return this.stock.viaCallback();
  }

  @Get("mysql/failing")
  async failing() {
    await this.stock.failing().catch(() => undefined);
    return { ok: true };
  }

  @Get("mysql/transaction")
  async transaction() {
    await this.stock.transaction();
    return { ok: true };
  }

  @Get("mysql/streamed")
  async streamed() {
    return { rows: await this.stock.streamed() };
  }

  @Get("mysql/concurrent")
  async concurrent() {
    await this.stock.concurrent();
    return { ok: true };
  }

  @Get("mysql/n-plus-one")
  async nPlusOne() {
    await this.stock.nPlusOne();
    return { ok: true };
  }

  @Get("mongo/cursor")
  async mongoCursor() {
    await this.stock.mongoCursorAndAggregate();
    return { ok: true };
  }

  @Get("mongo/duplicate")
  async mongoDuplicate() {
    await this.stock.mongoDuplicateKey().catch(() => undefined);
    return { ok: true };
  }

  @Get("mongo/concurrent")
  async mongoConcurrent() {
    await this.stock.mongoConcurrent();
    return { ok: true };
  }

  @Get("mongo")
  async mongo() {
    await this.stock.mongoRoundTrip();
    return { ok: true };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [StockController],
  providers: [StockService],
})
class DriversTestModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[],
  className: string,
): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children ?? [], className),
  ]);

/**
 * The `mysql2` and `mongodb` integrations against the real drivers and real
 * servers.
 *
 * The unit spec for these patches stands in fakes shaped like each driver,
 * which proves the wrapper's logic and nothing about the driver: whether the
 * prototype that owns `query` is the one patched, whether a pool hands its
 * command to a connection the way the fake assumes, whether MongoDB's
 * `Connection#command` is still where every operation ends up. Only the real
 * thing answers those, and they are the questions a driver release changes.
 */
describe("ObserveModule: mysql2 and mongodb spans", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(DriversTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();

    // After the app: the agent patches each driver from its constructor.
    if (mysqlReachable) {
      pool = mysqlPromise.createPool({ ...MYSQL, connectionLimit: 2 });
      callbackConnection = mysql.createConnection(MYSQL);
    }
    if (mongoReachable) {
      mongo = await MongoClient.connect(
        `mongodb://${MONGO_HOST}:${MONGO_PORT}`,
        { serverSelectionTimeoutMS: 3000 },
      );
    }
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    callbackConnection?.destroy();
    await mongo
      ?.db("observe_int")
      .dropDatabase()
      .catch(() => undefined);
    await mongo?.close().catch(() => undefined);
    await app?.close();
  });

  beforeEach(() => collected.clear());

  const queriesFor = async (path: string, className: string) => {
    await request(app.getHttpServer()).get(path).expect(200);
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === path,
    );
    const [service] = spansOf(
      snapshot.traces as CompleteTraceEventNode[],
      "StockService",
    );
    return { snapshot, spans: spansOf(service.children, className) };
  };

  describe.skipIf(!mysqlReachable)("mysql2", () => {
    it("records one span for a promise-pool query, under its caller, without its literals", async () => {
      const { snapshot, spans } = await queriesFor("/mysql/pool", "mysql2");

      // One: the pool's span covers the connection the command is handed to.
      expect(spans).toHaveLength(1);
      expect(spans[0].methodKey).toBe("SELECT");
      expect(spans[0].duration).toBeGreaterThan(0);
      expect(spans[0].tags).toEqual({
        "db.system": "mysql",
        "db.statement": "SELECT ? AS sku, ? AS note",
      });
      expect(JSON.stringify(snapshot)).not.toContain("secret-literal");
    });

    it("records a prepared statement run through execute()", async () => {
      const { spans } = await queriesFor("/mysql/execute", "mysql2");

      expect(spans).toHaveLength(1);
      expect(spans[0].tags?.["db.statement"]).toBe("SELECT ? + ? AS next");
    });

    it("records a callback-style query on a bare connection", async () => {
      const { spans } = await queriesFor("/mysql/callback", "mysql2");

      expect(spans).toHaveLength(1);
      expect(spans[0].error).toBeUndefined();
    });

    it("records a transaction as its statements, on the connection that ran them", async () => {
      const { spans } = await queriesFor("/mysql/transaction", "mysql2");

      expect(spans.map((span) => span.methodKey)).toEqual([
        "START",
        "SELECT",
        "COMMIT",
      ]);
    });

    it("closes the span of a streamed query when the stream ends, without taking over its errors", async () => {
      const { spans } = await queriesFor("/mysql/streamed", "mysql2");

      expect(spans).toHaveLength(1);
      expect(spans[0].duration).toBeGreaterThan(0);
    });

    it("records concurrent queries once each, all under the method that fanned out", async () => {
      const { snapshot, spans } = await queriesFor(
        "/mysql/concurrent",
        "mysql2",
      );

      expect(spans).toHaveLength(3);
      // None escaped to the root or to another span.
      expect(
        spansOf(snapshot.traces as CompleteTraceEventNode[], "mysql2"),
      ).toHaveLength(3);
    });

    it("collapses an N+1 into one node that says how many", async () => {
      const { spans } = await queriesFor("/mysql/n-plus-one", "mysql2");

      expect(spans.length).toBeLessThan(30);
      expect(
        spans.some((span) => Number(span.tags?.["observe.collapsed"]) > 0),
      ).toBe(true);
    });

    it("marks the query that failed, and names its table", async () => {
      const { spans } = await queriesFor("/mysql/failing", "mysql2");

      expect(spans).toHaveLength(1);
      expect(spans[0].methodKey).toBe("SELECT missing_table_observe");
      expect(spans[0].error).toBeTruthy();
    });
  });

  describe.skipIf(!mongoReachable)("mongodb", () => {
    it("records cursors, aggregation, updates, deletes and bulk writes as the commands they become", async () => {
      const { snapshot, spans } = await queriesFor("/mongo/cursor", "mongodb");

      const operations = new Set(spans.map((span) => span.methodKey));
      for (const expected of [
        "insert orders",
        "find orders",
        "aggregate orders",
        "update orders",
        "delete orders",
      ]) {
        expect(operations).toContain(expected);
      }
      // An aggregation pipeline keeps its stages and operators, not its values.
      const aggregate = spans.find(
        (span) => span.methodKey === "aggregate orders",
      )!;
      const statement = String(aggregate.tags?.["db.statement"]);
      expect(statement).toContain("$match");
      expect(statement).toContain("$group");
      expect(JSON.stringify(snapshot)).not.toContain("sku-1");
    });

    it("shows a rejected write on the method that made it, where the driver raises it", async () => {
      await request(app.getHttpServer()).get("/mongo/duplicate").expect(200);
      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/mongo/duplicate",
      );
      const [service] = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "StockService",
      );
      const inserts = spansOf(service.children, "mongodb").filter(
        (span) => span.methodKey === "insert unique_things",
      );

      // Both inserts reached the server and both commands returned: a
      // duplicate key travels back inside a successful reply.
      expect(inserts).toHaveLength(2);
      expect(inserts.every((span) => span.error === undefined)).toBe(true);
      // The failure is on the calling method, one row above them.
      // `true` rather than a payload: the controller caught it, and the agent
      // records a handled error as having happened without its details.
      expect(service.error).toBeTruthy();
    });

    it("records concurrent commands once each, and none of the handshakes the pool ran to serve them", async () => {
      const { spans } = await queriesFor("/mongo/concurrent", "mongodb");

      expect(spans.map((span) => span.methodKey).sort()).toEqual([
        "aggregate things",
        "find things",
        "find things",
      ]);
      expect(spans.every((span) => span.duration >= 0)).toBe(true);
    });

    it("records each command by name and collection, with the shape and none of the values", async () => {
      const { snapshot, spans } = await queriesFor("/mongo", "mongodb");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("insert users");
      expect(operations).toContain("find users");

      const find = spans.find((span) => span.methodKey === "find users")!;
      expect(find.tags?.["db.system"]).toBe("mongodb");
      const statement = JSON.parse(String(find.tags?.["db.statement"]));
      expect(statement.filter).toEqual({ email: "?", age: { $gt: "?" } });
      expect(JSON.stringify(snapshot)).not.toContain("kamil@example.com");
      expect(find.duration).toBeGreaterThan(0);
    });
  });
});
