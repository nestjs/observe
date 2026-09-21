import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { EntitySchema as MikroEntitySchema, MikroORM } from "@mikro-orm/core";
import { MySqlDriver } from "@mikro-orm/mysql";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { eq } from "drizzle-orm";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import {
  int,
  mysqlTable,
  varchar as mysqlVarchar,
} from "drizzle-orm/mysql-core";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { integer, pgTable, varchar as pgVarchar } from "drizzle-orm/pg-core";
import mongoose from "mongoose";
import mysql2 from "mysql2/promise";
import pg from "pg";
import { connect } from "net";
import request from "supertest";
import { DataSource, EntitySchema } from "typeorm";
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
  username: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "root",
  database: process.env.MYSQL_DATABASE ?? "test",
};
const POSTGRES = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54321),
  username: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres-whisprr",
  database: process.env.PGDATABASE ?? "postgres",
};
const MONGO_URL = `mongodb://${process.env.MONGO_HOST ?? "127.0.0.1"}:${
  process.env.MONGO_PORT ?? 27027
}/observe_orm_int`;

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

const mysqlReachable = await reachable(MYSQL.host, MYSQL.port);
const postgresReachable = await reachable(POSTGRES.host, POSTGRES.port);
const mongoReachable = await reachable(
  process.env.MONGO_HOST ?? "127.0.0.1",
  Number(process.env.MONGO_PORT ?? 27027),
);

interface Widget {
  id: number;
  name: string;
  secretNote: string;
}

// An EntitySchema rather than a decorated class: it needs no decorator
// metadata, so the suite does not depend on how the test transform is set up.
const WidgetSchema = new EntitySchema<Widget>({
  name: "Widget",
  tableName: "observe_orm_widget",
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String },
    secretNote: { type: String },
  },
});

// Drizzle: tables are plain objects, and the driver is handed in - which is
// the peer-dependency arrangement, so it runs on the application's own copy.
const pgGadgets = pgTable("observe_orm_gadget", {
  id: integer("id").primaryKey(),
  name: pgVarchar("name", { length: 64 }),
  secretNote: pgVarchar("secret_note", { length: 64 }),
});
const mysqlGadgets = mysqlTable("observe_orm_gadget", {
  id: int("id").primaryKey(),
  name: mysqlVarchar("name", { length: 64 }),
  secretNote: mysqlVarchar("secret_note", { length: 64 }),
});

interface Gizmo {
  id: number;
  name: string;
  secretNote: string;
}
const GizmoSchema = new MikroEntitySchema<Gizmo>({
  name: "Gizmo",
  tableName: "observe_orm_gizmo",
  properties: {
    id: { type: "number", primary: true },
    name: { type: "string" },
    secretNote: { type: "string" },
  },
});

const { ObserveModule, ObserveInstrument } = createObserveModule();

let drizzlePgPool: pg.Pool;
let drizzleMysqlPool: mysql2.Pool;
let mikroPostgres: MikroORM;
let mikroMysql: MikroORM;
let mysqlSource: DataSource;
let postgresSource: DataSource;
// `any`: Mongoose infers optional, nullable fields from a bare schema, and
// the document shape is not what is under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let WidgetModel: mongoose.Model<any>;

@Injectable()
class WidgetsService {
  async typeormRoundTrip(source: DataSource) {
    const widgets = source.getRepository(WidgetSchema);
    await widgets.save({ name: "sprocket", secretNote: "do-not-ship-me" });
    return widgets.find({ where: { name: "sprocket" }, take: 5 });
  }

  typeormMysql() {
    return this.typeormRoundTrip(mysqlSource);
  }

  typeormPostgres() {
    return this.typeormRoundTrip(postgresSource);
  }

  async typeormTransaction() {
    await postgresSource.transaction(async (manager) => {
      await manager
        .getRepository(WidgetSchema)
        .save({ name: "in-tx", secretNote: "do-not-ship-me" });
    });
  }

  async drizzlePostgres() {
    const db = drizzlePg(drizzlePgPool);
    await db
      .insert(pgGadgets)
      .values({ id: 1, name: "sprocket", secretNote: "do-not-ship-me" });
    return db.select().from(pgGadgets).where(eq(pgGadgets.name, "sprocket"));
  }

  async drizzleMysql() {
    const db = drizzleMysql(drizzleMysqlPool);
    await db
      .insert(mysqlGadgets)
      .values({ id: 1, name: "sprocket", secretNote: "do-not-ship-me" });
    return db
      .select()
      .from(mysqlGadgets)
      .where(eq(mysqlGadgets.name, "sprocket"));
  }

  async mikroRoundTrip(orm: MikroORM) {
    // A fork per unit of work, as MikroORM asks of every request handler.
    const em = orm.em.fork();
    em.create(GizmoSchema, {
      id: 1,
      name: "sprocket",
      secretNote: "do-not-ship-me",
    });
    await em.flush();
    return em.fork().find(GizmoSchema, { name: "sprocket" });
  }

  mikroPostgres() {
    return this.mikroRoundTrip(mikroPostgres);
  }

  mikroMysql() {
    return this.mikroRoundTrip(mikroMysql);
  }

  async mongooseRoundTrip() {
    await WidgetModel.create({
      name: "sprocket",
      secretNote: "do-not-ship-me",
    });
    return WidgetModel.find({ name: "sprocket" }).limit(5).lean();
  }
}

@Controller()
class WidgetsController {
  constructor(private readonly widgets: WidgetsService) {}

  @Get("typeorm/mysql")
  async mysql() {
    await this.widgets.typeormMysql();
    return { ok: true };
  }

  @Get("typeorm/postgres")
  async postgres() {
    await this.widgets.typeormPostgres();
    return { ok: true };
  }

  @Get("typeorm/transaction")
  async transaction() {
    await this.widgets.typeormTransaction();
    return { ok: true };
  }

  @Get("drizzle/postgres")
  async drizzlePostgres() {
    await this.widgets.drizzlePostgres();
    return { ok: true };
  }

  @Get("drizzle/mysql")
  async drizzleMysql() {
    await this.widgets.drizzleMysql();
    return { ok: true };
  }

  @Get("mikro-orm/postgres")
  async mikroPostgres() {
    await this.widgets.mikroPostgres();
    return { ok: true };
  }

  @Get("mikro-orm/mysql")
  async mikroMysql() {
    await this.widgets.mikroMysql();
    return { ok: true };
  }

  @Get("mongoose")
  async mongoose() {
    await this.widgets.mongooseRoundTrip();
    return { ok: true };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [WidgetsController],
  providers: [WidgetsService],
})
class OrmTestModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[],
  className: string,
): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children ?? [], className),
  ]);

/**
 * The claim the driver patches rest on: nobody instruments an ORM, because
 * every ORM ends in one of three drivers. Tested here with the ORMs
 * themselves rather than argued - real TypeORM over `mysql2` and over `pg`,
 * real Mongoose over `mongodb` - each driven the way an application drives
 * it, through a repository or a model, with no code that knows Observe is
 * there.
 *
 * What would break this, and what these tests would catch: an ORM loading a
 * private copy of its driver (Mongoose does when versions disagree), an ORM
 * reaching the driver through an entry point the patch does not cover, or a
 * pool handing work to a connection in a way that loses the caller's context.
 */
describe("ObserveModule: ORM coverage through the drivers", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(OrmTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();

    // After the app, as an application's own providers would be: the agent
    // patches each driver from its constructor.
    if (mysqlReachable) {
      mysqlSource = await new DataSource({
        type: "mysql",
        ...MYSQL,
        entities: [WidgetSchema],
        synchronize: true,
        dropSchema: false,
      }).initialize();
    }
    if (postgresReachable) {
      postgresSource = await new DataSource({
        type: "postgres",
        ...POSTGRES,
        entities: [WidgetSchema],
        synchronize: true,
      }).initialize();
    }
    if (postgresReachable) {
      drizzlePgPool = new pg.Pool({
        host: POSTGRES.host,
        port: POSTGRES.port,
        user: POSTGRES.username,
        password: POSTGRES.password,
        database: POSTGRES.database,
        max: 2,
      });
      await drizzlePgPool.query(
        `DROP TABLE IF EXISTS observe_orm_gadget;
         CREATE TABLE observe_orm_gadget (id int PRIMARY KEY, name varchar(64), secret_note varchar(64))`,
      );
      mikroPostgres = await MikroORM.init({
        driver: PostgreSqlDriver,
        host: POSTGRES.host,
        port: POSTGRES.port,
        user: POSTGRES.username,
        password: POSTGRES.password,
        dbName: POSTGRES.database,
        entities: [GizmoSchema],
        allowGlobalContext: true,
      });
      // Plain DDL through MikroORM's own connection: the schema generator's
      // API moved between majors, and the table is all this needs.
      await mikroPostgres.em
        .getConnection()
        .execute("DROP TABLE IF EXISTS observe_orm_gizmo");
      await mikroPostgres.em
        .getConnection()
        .execute(
          "CREATE TABLE IF NOT EXISTS observe_orm_gizmo (id int PRIMARY KEY, name varchar(64), secret_note varchar(64))",
        );
    }
    if (mysqlReachable) {
      drizzleMysqlPool = mysql2.createPool({
        host: MYSQL.host,
        port: MYSQL.port,
        user: MYSQL.username,
        password: MYSQL.password,
        database: MYSQL.database,
        connectionLimit: 2,
      });
      await drizzleMysqlPool.query("DROP TABLE IF EXISTS observe_orm_gadget");
      await drizzleMysqlPool.query(
        "CREATE TABLE observe_orm_gadget (id int PRIMARY KEY, name varchar(64), secret_note varchar(64))",
      );
      mikroMysql = await MikroORM.init({
        driver: MySqlDriver,
        host: MYSQL.host,
        port: MYSQL.port,
        user: MYSQL.username,
        password: MYSQL.password,
        dbName: MYSQL.database,
        entities: [GizmoSchema],
        allowGlobalContext: true,
      });
      // Plain DDL through MikroORM's own connection: the schema generator's
      // API moved between majors, and the table is all this needs.
      await mikroMysql.em
        .getConnection()
        .execute("DROP TABLE IF EXISTS observe_orm_gizmo");
      await mikroMysql.em
        .getConnection()
        .execute(
          "CREATE TABLE IF NOT EXISTS observe_orm_gizmo (id int PRIMARY KEY, name varchar(64), secret_note varchar(64))",
        );
    }
    if (mongoReachable) {
      await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 3000 });
      WidgetModel = mongoose.model(
        "Widget",
        new mongoose.Schema({ name: String, secretNote: String }),
      ) as unknown as typeof WidgetModel;
    }
  });

  afterAll(async () => {
    for (const source of [mysqlSource, postgresSource]) {
      if (source?.isInitialized) {
        await source.query("DROP TABLE IF EXISTS observe_orm_widget");
        await source.destroy();
      }
    }
    await drizzlePgPool
      ?.query("DROP TABLE IF EXISTS observe_orm_gadget")
      .catch(() => undefined);
    await drizzlePgPool?.end().catch(() => undefined);
    await drizzleMysqlPool
      ?.query("DROP TABLE IF EXISTS observe_orm_gadget")
      .catch(() => undefined);
    await drizzleMysqlPool?.end().catch(() => undefined);
    for (const orm of [mikroPostgres, mikroMysql]) {
      await orm?.em
        .getConnection()
        .execute("DROP TABLE IF EXISTS observe_orm_gizmo")
        .catch(() => undefined);
      await orm?.close(true).catch(() => undefined);
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
    }
    await app?.close();
  });

  beforeEach(() => collected.clear());

  const spansFor = async (path: string, className: string) => {
    await request(app.getHttpServer()).get(path).expect(200);
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === path,
    );
    const [service] = spansOf(
      snapshot.traces as CompleteTraceEventNode[],
      "WidgetsService",
    );
    return { snapshot, spans: spansOf(service.children, className) };
  };

  it.skipIf(!mysqlReachable)(
    "records TypeORM's statements on MySQL under the service method, values gone",
    async () => {
      const { snapshot, spans } = await spansFor("/typeorm/mysql", "mysql2");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_widget");
      expect(operations).toContain("SELECT observe_orm_widget");
      expect(spans.every((span) => span.tags?.["db.system"] === "mysql")).toBe(
        true,
      );
      // TypeORM binds its values, and the agent never reads bound values.
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
      expect(JSON.stringify(snapshot)).not.toContain("sprocket");
    },
  );

  it.skipIf(!postgresReachable)(
    "records TypeORM's statements on Postgres the same way",
    async () => {
      const { snapshot, spans } = await spansFor("/typeorm/postgres", "pg");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_widget");
      expect(operations).toContain("SELECT observe_orm_widget");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );

  it.skipIf(!postgresReachable)(
    "keeps a TypeORM transaction's statements in the trace that opened it",
    async () => {
      const { spans } = await spansFor("/typeorm/transaction", "pg");

      const operations = spans.map((span) => span.methodKey);
      // The query runner holds one connection across the callback; every
      // statement on it still has to find the request's context.
      expect(operations[0]).toMatch(/^(START|BEGIN)/);
      expect(operations).toContain("INSERT observe_orm_widget");
      expect(operations[operations.length - 1]).toBe("COMMIT");
    },
  );

  it.skipIf(!postgresReachable)(
    "records Drizzle's statements on Postgres",
    async () => {
      const { snapshot, spans } = await spansFor("/drizzle/postgres", "pg");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_gadget");
      expect(operations).toContain("SELECT observe_orm_gadget");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );

  it.skipIf(!mysqlReachable)(
    "records Drizzle's statements on MySQL",
    async () => {
      const { snapshot, spans } = await spansFor("/drizzle/mysql", "mysql2");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_gadget");
      expect(operations).toContain("SELECT observe_orm_gadget");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );

  it.skipIf(!postgresReachable)(
    "records MikroORM's statements on Postgres",
    async () => {
      const { snapshot, spans } = await spansFor("/mikro-orm/postgres", "pg");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_gizmo");
      expect(operations).toContain("SELECT observe_orm_gizmo");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );

  it.skipIf(!mysqlReachable)(
    "records MikroORM's statements on MySQL, which runs on a copy of the driver nested inside it",
    async () => {
      const { snapshot, spans } = await spansFor("/mikro-orm/mysql", "mysql2");

      // MikroORM pins `mysql2` to an exact version, so npm gives it a private
      // copy whenever the application's differs by so much as a patch. Patching
      // only the copy the agent itself resolves records nothing here.
      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("INSERT observe_orm_gizmo");
      expect(operations).toContain("SELECT observe_orm_gizmo");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );

  it.skipIf(!mongoReachable)(
    "records Mongoose's operations through whichever copy of the driver Mongoose runs on",
    async () => {
      const { snapshot, spans } = await spansFor("/mongoose", "mongodb");

      const operations = spans.map((span) => span.methodKey);
      expect(operations).toContain("insert widgets");
      expect(operations).toContain("find widgets");
      const find = spans.find((span) => span.methodKey === "find widgets")!;
      expect(JSON.parse(String(find.tags?.["db.statement"])).filter).toEqual({
        name: "?",
      });
      expect(JSON.stringify(snapshot)).not.toContain("do-not-ship-me");
    },
  );
});
