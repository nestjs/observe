import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import {
  createServer,
  get as httpGet,
  IncomingHttpHeaders,
  Server,
} from "http";
import { connect } from "net";
import pg from "pg";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const PG = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54321),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres-whisprr",
  database: process.env.PGDATABASE ?? "postgres",
};

/** The query assertions need a real server; the HTTP ones do not. */
const postgresReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: PG.host, port: PG.port });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const { ObserveModule, ObserveInstrument } = createObserveModule();

let downstreamUrl = "";
let pool: pg.Pool;

@Injectable()
class ReportsService {
  async viaPool() {
    const { rows } = await pool.query(
      "SELECT $1::int AS id, 'secret-literal' AS note",
      [7],
    );
    return rows[0];
  }

  async viaClient() {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1 AS one");
      await client.query("SELECT nope FROM missing_table_observe");
    } finally {
      client.release();
    }
  }

  async nPlusOne() {
    for (let id = 0; id < 30; id += 1) {
      await pool.query("SELECT $1::int AS id", [id]);
    }
  }

  async viaFetch() {
    const response = await fetch(
      `${downstreamUrl}/rates?token=s3cret&base=usd`,
    );
    return response.json();
  }

  viaNodeHttp() {
    return new Promise<void>((resolve, reject) => {
      httpGet(`${downstreamUrl}/legacy`, (response) => {
        response.resume();
        response.once("end", resolve);
      }).once("error", reject);
    });
  }
}

@Controller()
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("pool")
  pool() {
    return this.reports.viaPool();
  }

  @Get("client")
  async client() {
    await this.reports.viaClient().catch(() => undefined);
    return { ok: true };
  }

  @Get("n-plus-one")
  async nPlusOne() {
    await this.reports.nPlusOne();
    return { ok: true };
  }

  @Get("fetch")
  fetch() {
    return this.reports.viaFetch();
  }

  @Get("node-http")
  async nodeHttp() {
    await this.reports.viaNodeHttp();
    return { ok: true };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [ReportsController],
  providers: [ReportsService],
})
class OutgoingTestModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[],
  className: string,
): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children ?? [], className),
  ]);

/**
 * Database and outbound HTTP spans, end to end: a real driver against a real
 * server, a real `fetch` against a real listener. What is being proven is
 * placement as much as presence - the span has to sit under the service
 * method that made the call, which only holds if it was opened in that
 * method's async context.
 */
describe("ObserveModule: outgoing spans", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;
  let downstream: Server;
  const received: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    downstream = createServer((req, res) => {
      received.push(req.headers);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => downstream.listen(port, resolve));
    downstreamUrl = `http://127.0.0.1:${port}`;

    app = await NestFactory.create<NestExpressApplication>(OutgoingTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();
    // After the app: the agent patches the driver from its constructor, and a
    // pool is only instrumented through the prototype it shares.
    pool = new pg.Pool({ ...PG, max: 2 });
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await app?.close();
    await new Promise((resolve) => downstream.close(resolve));
  });

  beforeEach(() => {
    collected.clear();
    received.length = 0;
  });

  describe.skipIf(!postgresReachable)("pg", () => {
    it("records one span for a pool query, under the method that ran it, without its literals", async () => {
      await request(app.getHttpServer()).get("/pool").expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/pool",
      );
      const [service] = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "ReportsService",
      );
      const queries = spansOf(service.children, "pg");

      // One, not two: the pool's span covers the client call it delegates to.
      expect(queries).toHaveLength(1);
      expect(queries[0].methodKey).toBe("SELECT");
      expect(queries[0].duration).toBeGreaterThan(0);
      expect(queries[0].tags).toEqual({
        "db.system": "postgresql",
        "db.statement": "SELECT $1::int AS id, ? AS note",
      });
      expect(JSON.stringify(snapshot)).not.toContain("secret-literal");
    });

    it("records client queries, and marks the one that failed", async () => {
      await request(app.getHttpServer()).get("/client").expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/client",
      );
      const queries = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "pg",
      );

      expect(queries.map((query) => query.methodKey)).toEqual([
        "SELECT",
        "SELECT missing_table_observe",
      ]);
      expect(queries[0].error).toBeUndefined();
      expect(queries[1].error).toBeTruthy();
    });

    it("collapses an N+1 into one node that says how many", async () => {
      await request(app.getHttpServer()).get("/n-plus-one").expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/n-plus-one",
      );
      const queries = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "pg",
      );

      expect(queries.length).toBeLessThan(30);
      expect(
        queries.some((query) => Number(query.tags?.["observe.collapsed"]) > 0),
      ).toBe(true);
    });
  });

  it("records a fetch() call, masks its query string, and forwards the trace id", async () => {
    await request(app.getHttpServer())
      .get("/fetch")
      .set("x-request-id", "outgoing-trace-1")
      .expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/fetch",
    );
    const [call] = spansOf(snapshot.traces as CompleteTraceEventNode[], "http");

    expect(call.methodKey).toBe(`GET ${downstreamUrl.replace("http://", "")}`);
    expect(String(call.tags?.["http.url"])).toContain("base=usd");
    expect(String(call.tags?.["http.url"])).not.toContain("s3cret");
    expect(received[0]["x-request-id"]).toBe("outgoing-trace-1");
  });

  it("records a node:http request", async () => {
    await request(app.getHttpServer()).get("/node-http").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/node-http",
    );
    const calls = spansOf(snapshot.traces as CompleteTraceEventNode[], "http");

    expect(calls).toHaveLength(1);
    expect(calls[0].methodKey).toMatch(/^GET 127\.0\.0\.1:\d+$/);
    expect(calls[0].error).toBeUndefined();
  });
});
