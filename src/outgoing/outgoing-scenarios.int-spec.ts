import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Query,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  createServer,
  IncomingHttpHeaders,
  request as httpRequest,
  Server,
} from "http";
import { connect } from "net";
import pg from "pg";
import request from "supertest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
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

/**
 * `http.client.request.created` - the only `node:http` channel published
 * while headers can still be set - arrived in Node 22.12.
 */
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeHttpCanPropagate =
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);

let downstreamUrl = "";
let deadUrl = "";
let pool: pg.Pool;
let narrowPool: pg.Pool;

/** A `node:http` request as a promise, with the knobs the scenarios turn. */
function nodeHttp(
  url: string,
  options: { headers?: Record<string, string>; destroyAfterMs?: number } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers: options.headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    if (options.destroyAfterMs !== undefined) {
      setTimeout(() => req.destroy(), options.destroyAfterMs);
    }
    req.end();
  });
}

@Injectable()
class LedgerService {
  // --- pg -----------------------------------------------------------------
  poolCallback() {
    return new Promise((resolve, reject) =>
      pool.query("SELECT $1::int AS id", [1], (error, result) =>
        error ? reject(error) : resolve(result.rows),
      ),
    );
  }

  poolCallbackFailing() {
    return new Promise((resolve) =>
      pool.query("SELECT nope FROM missing_table_observe", (error) =>
        resolve(error?.message),
      ),
    );
  }

  async clientCallback() {
    const client = await pool.connect();
    try {
      await new Promise((resolve, reject) =>
        client.query("SELECT 2 AS two", (error, result) =>
          error ? reject(error) : resolve(result),
        ),
      );
    } finally {
      client.release();
    }
  }

  async configObjects() {
    await pool.query({ text: "SELECT $1::text AS plain", values: ["v-1"] });
    await pool.query({
      name: "observe-named-statement",
      text: "SELECT $1::text AS named",
      values: ["v-2"],
    });
    // The second run of a named statement skips the parse - same call shape.
    await pool.query({
      name: "observe-named-statement",
      text: "SELECT $1::text AS named",
      values: ["v-3"],
    });
    await pool.query({
      text: "SELECT $1::text AS arr",
      values: ["v-4"],
      rowMode: "array",
    });
  }

  async configCallback() {
    const client = await pool.connect();
    try {
      await new Promise((resolve, reject) =>
        client.query({
          text: "SELECT 3 AS three",
          callback: (error: Error | null, result: unknown) =>
            error ? reject(error) : resolve(result),
        } as never),
      );
    } finally {
      client.release();
    }
  }

  async transaction(outcome: "commit" | "rollback") {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "CREATE TEMP TABLE IF NOT EXISTS observe_ledger (id int, note text) ON COMMIT DROP",
      );
      await client.query(
        "INSERT INTO observe_ledger (id, note) VALUES ($1, $2)",
        [1, "bound-secret-value"],
      );
      await client.query(outcome === "commit" ? "COMMIT" : "ROLLBACK");
    } finally {
      client.release();
    }
  }

  async failingTransaction() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT nope FROM missing_table_observe");
    } catch {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }

  async interpolated() {
    await pool.query(
      `SELECT 'literal-secret' AS s, 4242424242 AS n, $tag$dollar-secret$tag$ AS d
       FROM generate_series(1, 2) AS g /* comment-secret */
       WHERE g IN (1, 2, 3) AND 'x' <> 'in-list-secret' -- trailing-secret`,
    );
  }

  async rejecting() {
    await pool.query("SELECT nope FROM missing_table_observe");
  }

  async submittable() {
    const client = await pool.connect();
    try {
      const rows: unknown[] = [];
      await new Promise<void>((resolve, reject) => {
        const query = client.query(
          new pg.Query("SELECT g FROM generate_series(1, 3) AS g"),
        );
        query.on("row", (row: unknown) => rows.push(row));
        query.on("error", reject);
        query.on("end", () => resolve());
      });
      return rows.length;
    } finally {
      client.release();
    }
  }

  async queuedCheckout(tag: string) {
    // One connection, two requests: the second query waits for a checkout
    // that completes inside whichever request releases the connection.
    await narrowPool.query(`SELECT pg_sleep(0.05), '${tag}' AS tag`);
    return tag;
  }

  // --- outbound HTTP --------------------------------------------------------
  async fetchStatus(path: string, headers?: Record<string, string>) {
    const response = await fetch(`${downstreamUrl}${path}`, { headers });
    await response.text();
    return response.status;
  }

  async fetchPost() {
    const response = await fetch(`${downstreamUrl}/orders`, {
      method: "POST",
      body: JSON.stringify({ card: "4242424242424242" }),
      headers: { "content-type": "application/json" },
    });
    return response.status;
  }

  async fetchWithHeadersObject() {
    const headers = new Headers();
    headers.set("X-Request-Id", "caller-supplied-2");
    const response = await fetch(`${downstreamUrl}/mixed-case`, { headers });
    return response.status;
  }

  async fetchRefused() {
    await fetch(`${deadUrl}/nobody-home`);
  }

  async fetchAborted() {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 40);
    await fetch(`${downstreamUrl}/hang`, { signal: controller.signal });
  }

  nodeStatus(path: string, headers?: Record<string, string>) {
    return nodeHttp(`${downstreamUrl}${path}`, { headers });
  }

  nodeWithOwnId() {
    return nodeHttp(`${downstreamUrl}/own-id`, {
      headers: { "X-Request-Id": "caller-supplied-3" },
    });
  }

  nodeRefused() {
    return nodeHttp(`${deadUrl}/nobody-home`);
  }

  nodeDestroyed() {
    return nodeHttp(`${downstreamUrl}/hang`, { destroyAfterMs: 40 });
  }

  fanOut() {
    return Promise.all([
      fetch(`${downstreamUrl}/a`).then((response) => response.text()),
      fetch(`${downstreamUrl}/b`).then((response) => response.text()),
      nodeHttp(`${downstreamUrl}/c`),
    ]);
  }
}

@Controller()
class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get("run")
  async run(@Query("scenario") scenario: string, @Query("arg") arg?: string) {
    const method = (this.ledger as unknown as Record<string, unknown>)[
      scenario
    ] as (...args: unknown[]) => Promise<unknown>;
    let failure: string | undefined;
    const result = await method
      .call(this.ledger, arg)
      .catch((error: Error) => void (failure = error.name));
    return { result, failure };
  }
}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

async function bootApp(overrides: Partial<ObserveOptions> = {}) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers: [LedgerController],
    providers: [LedgerService],
  })
  class ScenariosModule {}

  const app = await NestFactory.create(ScenariosModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  const collected = collectSnapshots(app);
  await app.init();
  return { app, collected };
}

/**
 * The outgoing suite's second pass: the call shapes and failure modes the
 * first one leaves out.
 *
 * Every scenario is one method of `LedgerService`, run through a single
 * route, so each trace has the same skeleton - controller, service method,
 * and under it whatever left the process. A driver patch is process-wide and
 * the newest agent's wins, so the applications below boot one after another,
 * each describe block done before the next one's `beforeAll`.
 */
describe("ObserveModule: outgoing span scenarios", () => {
  let downstream: Server;
  const received: Array<{ url?: string; headers: IncomingHttpHeaders }> = [];

  beforeAll(async () => {
    downstream = createServer((req, res) => {
      received.push({ url: req.url, headers: req.headers });
      if (req.url === "/hang") {
        return; // never answered; the caller gives up
      }
      res.statusCode = req.url === "/broken" ? 503 : 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => downstream.listen(port, resolve));
    downstreamUrl = `http://127.0.0.1:${port}`;
    // A port nothing listens on: reserved, then released.
    deadUrl = `http://127.0.0.1:${await freePort()}`;
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await narrowPool?.end().catch(() => undefined);
    downstream.closeAllConnections();
    await new Promise((resolve) => downstream.close(resolve));
  });

  describe("with the defaults", () => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      ({ app, collected } = await bootApp());
      if (postgresReachable) {
        pool = new pg.Pool({ ...PG, max: 3 });
        narrowPool = new pg.Pool({ ...PG, max: 1 });
      }
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      received.length = 0;
    });

    /** Runs one scenario and returns its trace, cut down to the service. */
    const run = async (
      scenario: string,
      options: { arg?: string; traceId?: string } = {},
    ) => {
      const call = request(app.getHttpServer())
        .get("/run")
        .query({ scenario, ...(options.arg ? { arg: options.arg } : {}) });
      if (options.traceId) {
        void call.set("x-request-id", options.traceId);
      }
      const response = await call.expect(200);
      const snapshot = await waitForSnapshot(
        collected,
        (item) =>
          item.attributes?.originalUrl?.includes(`scenario=${scenario}`) ===
            true &&
          (!options.traceId || item.traceId === options.traceId),
      );
      const [service] = spansOf(
        snapshot.traces as CompleteTraceEventNode[],
        "LedgerService",
      );
      return {
        body: response.body as { result?: unknown; failure?: string },
        snapshot,
        service,
        pg: spansOf(service?.children, "pg"),
        http: spansOf(service?.children, "http"),
      };
    };

    describe.skipIf(!postgresReachable)("pg", () => {
      it("records a callback-style pool query once, and still calls back", async () => {
        const { body, pg: queries } = await run("poolCallback");

        expect(body.result).toEqual([{ id: 1 }]);
        expect(queries).toHaveLength(1);
        expect(queries[0].error).toBeUndefined();
        expect(queries[0].duration).toBeGreaterThan(0);
      });

      it("marks a callback-style query that failed, and hands the callback its error", async () => {
        const { body, pg: queries } = await run("poolCallbackFailing");

        expect(String(body.result)).toContain("missing_table_observe");
        expect(queries).toHaveLength(1);
        expect(queries[0].methodKey).toBe("SELECT missing_table_observe");
        expect(queries[0].error).toBeTruthy();
      });

      it("records a callback-style query on a checked-out client", async () => {
        const { pg: queries } = await run("clientCallback");

        expect(queries.map((query) => query.methodKey)).toEqual(["SELECT"]);
      });

      it("reads the text of a query config object - plain, named and array-mode - and never its values", async () => {
        const { snapshot, pg: queries } = await run("configObjects");

        expect(queries.map((query) => query.tags?.["db.statement"])).toEqual([
          "SELECT $1::text AS plain",
          "SELECT $1::text AS named",
          "SELECT $1::text AS named",
          "SELECT $1::text AS arr",
        ]);
        const everything = JSON.stringify(snapshot);
        for (const value of ["v-1", "v-2", "v-3", "v-4"]) {
          expect(everything).not.toContain(value);
        }
        // The statement's name is an identifier the application chose, and
        // it is not recorded either.
        expect(everything).not.toContain("observe-named-statement");
      });

      it("ends the span through a callback carried on the config object", async () => {
        const { pg: queries } = await run("configCallback");

        expect(queries).toHaveLength(1);
        expect(queries[0].duration).toBeGreaterThan(0);
      });

      it.each(["commit", "rollback"])(
        "records a transaction on a checked-out client statement by statement (%s)",
        async (outcome) => {
          const { snapshot, pg: queries } = await run("transaction", {
            arg: outcome,
          });

          expect(queries.map((query) => query.methodKey)).toEqual([
            "BEGIN",
            "CREATE",
            "INSERT observe_ledger",
            outcome.toUpperCase(),
          ]);
          expect(JSON.stringify(snapshot)).not.toContain("bound-secret-value");
        },
      );

      it("marks only the statement that failed inside a transaction, and records the rollback after it", async () => {
        const { pg: queries } = await run("failingTransaction");

        expect(
          queries.map((query) => [query.methodKey, Boolean(query.error)]),
        ).toEqual([
          ["BEGIN", false],
          ["SELECT missing_table_observe", true],
          ["ROLLBACK", false],
        ]);
      });

      it("strips every literal an application interpolated: strings, numbers, dollar quotes, IN-lists and comments", async () => {
        const { snapshot, pg: queries } = await run("interpolated");

        expect(queries).toHaveLength(1);
        const statement = String(queries[0].tags?.["db.statement"]);
        expect(statement).toContain("generate_series");
        const everything = JSON.stringify(snapshot);
        for (const secret of [
          "literal-secret",
          "4242424242",
          "dollar-secret",
          "comment-secret",
          "in-list-secret",
          "trailing-secret",
        ]) {
          expect(everything).not.toContain(secret);
        }
      });

      it("marks a rejected promise query and leaves the rejection for the caller", async () => {
        const { body, service, pg: queries } = await run("rejecting");

        // The service method saw the driver's own error, untouched.
        expect(body.failure).toBe("error");
        expect(service.error).toBeTruthy();
        expect(queries).toHaveLength(1);
        expect(queries[0].error).toBeTruthy();
      });

      it("stands aside for a submittable (a cursor, a query stream): no span, and the rows still arrive", async () => {
        const { body, pg: queries } = await run("submittable");

        expect(body.result).toBe(3);
        expect(queries).toEqual([]);
      });

      it("records query spans as leaves, origin auto", async () => {
        const { pg: queries } = await run("poolCallback");

        expect(queries[0].origin).toBe("auto");
        expect(queries[0].children).toBeUndefined();
        expect(queries[0].spanId).toEqual(expect.any(String));
      });

      it("keeps each query under its own request when two requests queue for one connection", async () => {
        const [first, second] = await Promise.all([
          run("queuedCheckout", { arg: "first", traceId: "queued-trace-1" }),
          run("queuedCheckout", { arg: "second", traceId: "queued-trace-2" }),
        ]);

        expect(first.pg).toHaveLength(1);
        expect(second.pg).toHaveLength(1);
        expect(first.snapshot.traceId).toBe("queued-trace-1");
        expect(second.snapshot.traceId).toBe("queued-trace-2");
      });

      it("runs a query issued outside any trace untouched, and reports nothing for it", async () => {
        const viaPromise = await pool.query("SELECT 1 AS one");
        const viaCallback = await new Promise<pg.QueryResult>(
          (resolve, reject) =>
            pool.query("SELECT 2 AS two", (error, result) =>
              error ? reject(error) : resolve(result),
            ),
        );
        await expect(
          pool.query("SELECT nope FROM missing_table_observe"),
        ).rejects.toThrow(/missing_table_observe/);

        expect(viaPromise.rows).toEqual([{ one: 1 }]);
        expect(viaCallback.rows).toEqual([{ two: 2 }]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(collected.items).toEqual([]);
      });
    });

    describe("outbound HTTP", () => {
      it("records a non-2xx fetch() as a completed call: the span carries no error, because the request itself worked", async () => {
        const { body, http } = await run("fetchStatus", { arg: "/broken" });

        expect(body.result).toBe(503);
        expect(http).toHaveLength(1);
        expect(http[0].error).toBeUndefined();
        expect(http[0].duration).toBeGreaterThan(0);
      });

      it("records a non-2xx node:http response the same way", async () => {
        const { body, http } = await run("nodeStatus", { arg: "/broken" });

        expect(body.result).toBe(503);
        expect(http).toHaveLength(1);
        expect(http[0].error).toBeUndefined();
      });

      it("names the span after the method and host, and records no request body", async () => {
        const { snapshot, http } = await run("fetchPost");

        expect(http).toHaveLength(1);
        expect(http[0].methodKey).toBe(
          `POST ${downstreamUrl.replace("http://", "")}`,
        );
        expect(http[0].tags).toEqual({
          "http.method": "POST",
          "http.url": `${downstreamUrl}/orders`,
        });
        expect(JSON.stringify(snapshot)).not.toContain("4242424242424242");
      });

      it("marks a fetch() whose connection was refused, and still ships the trace", async () => {
        const { body, http } = await run("fetchRefused");

        expect(body.failure).toBe("TypeError");
        expect(http).toHaveLength(1);
        expect(http[0].error).toBeTruthy();
      });

      it("marks a node:http request whose connection was refused, exactly once", async () => {
        const { body, http } = await run("nodeRefused");

        expect(body.failure).toBe("Error");
        expect(http).toHaveLength(1);
        expect(http[0].error).toBeTruthy();
      });

      it("closes the span of a fetch() the caller aborted, as failed", async () => {
        const { body, http } = await run("fetchAborted");

        expect(body.failure).toBe("AbortError");
        expect(http).toHaveLength(1);
        expect(http[0].error).toBeTruthy();
        expect(http[0].duration).toBeGreaterThanOrEqual(30);
      });

      it("closes the span of a node:http request destroyed before any response, as failed", async () => {
        const { http } = await run("nodeDestroyed");

        expect(http).toHaveLength(1);
        expect(http[0].error).toBeTruthy();
      });

      it("records concurrent calls once each, as leaves, all under the method that fanned out", async () => {
        const { snapshot, http } = await run("fanOut");

        expect(http).toHaveLength(3);
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "http"),
        ).toHaveLength(3);
        for (const span of http) {
          expect(span.origin).toBe("auto");
          expect(span.children).toBeUndefined();
        }
      });

      it("injects the trace id into a fetch() that carries none", async () => {
        await run("fetchStatus", { arg: "/plain", traceId: "inject-trace-1" });

        const call = received.find((item) => item.url === "/plain")!;
        expect(call.headers["x-request-id"]).toBe("inject-trace-1");
      });

      it("never overwrites an x-request-id the caller set on a fetch(), however it was spelled", async () => {
        await run("fetchWithHeadersObject", { traceId: "inject-trace-2" });

        const call = received.find((item) => item.url === "/mixed-case")!;
        expect(call.headers["x-request-id"]).toBe("caller-supplied-2");
      });

      it.runIf(nodeHttpCanPropagate)(
        "injects the trace id into a node:http request that carries none, and keeps the caller's when it does",
        async () => {
          await run("nodeStatus", { arg: "/bare", traceId: "inject-trace-3" });
          const bare = received.find((item) => item.url === "/bare")!;
          expect(bare.headers["x-request-id"]).toBe("inject-trace-3");

          await run("nodeWithOwnId", { traceId: "inject-trace-4" });
          const own = received.find((item) => item.url === "/own-id")!;
          expect(own.headers["x-request-id"]).toBe("caller-supplied-3");
        },
      );

      it("makes outbound calls issued outside any trace untouched: no header, no snapshot, no throw", async () => {
        const response = await fetch(`${downstreamUrl}/outside`);
        await response.text();
        expect(await nodeHttp(`${downstreamUrl}/outside-node`)).toBe(200);
        await expect(fetch(`${deadUrl}/outside`)).rejects.toThrow();

        for (const call of received) {
          expect(call.headers).not.toHaveProperty("x-request-id");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(collected.items).toEqual([]);
      });
    });
  });

  describe("with outgoing.http.ignore", () => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      ({ app, collected } = await bootApp({
        outgoing: { http: { ignore: (url) => url.includes("/internal") } },
      }));
    });

    afterAll(async () => {
      await app?.close();
    });

    it("opens no span and sends no trace id for an ignored URL, through fetch() and node:http alike", async () => {
      received.length = 0;
      for (const scenario of ["fetchStatus", "nodeStatus"]) {
        await request(app.getHttpServer())
          .get("/run")
          .query({ scenario, arg: "/internal/metrics" })
          .set("x-request-id", "ignored-trace-1")
          .expect(200);
      }
      await waitForSnapshot(collected, () => collected.items.length >= 2);

      for (const snapshot of collected.items) {
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "http"),
        ).toEqual([]);
      }
      expect(received).toHaveLength(2);
      for (const call of received) {
        expect(call.headers).not.toHaveProperty("x-request-id");
      }
    });
  });

  describe.each<[string, ObserveOptions["outgoing"], boolean, boolean]>([
    ["outgoing: false", false, false, false],
    ["outgoing.database: false", { database: false }, false, true],
    ["outgoing.http: false", { http: false }, true, false],
  ])("with %s", (_label, outgoing, expectsQueries, expectsHttp) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      ({ app, collected } = await bootApp({ outgoing }));
    });

    afterAll(async () => {
      await app?.close();
    });

    it.skipIf(!postgresReachable)(
      `${expectsQueries ? "records" : "records no"} query spans`,
      async () => {
        collected.clear();
        await request(app.getHttpServer())
          .get("/run")
          .query({ scenario: "poolCallback" })
          .expect(200);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/run",
        );
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "pg"),
        ).toHaveLength(expectsQueries ? 1 : 0);
      },
    );

    it(
      expectsHttp
        ? "records HTTP spans and propagates"
        : "records no HTTP spans and sends no trace id",
      async () => {
        collected.clear();
        received.length = 0;
        await request(app.getHttpServer())
          .get("/run")
          .query({ scenario: "fetchStatus", arg: "/toggle" })
          .set("x-request-id", "toggle-trace-1")
          .expect(200);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/run",
        );
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "http"),
        ).toHaveLength(expectsHttp ? 1 : 0);
        expect(received[0].headers["x-request-id"]).toBe(
          expectsHttp ? "toggle-trace-1" : undefined,
        );
      },
    );
  });
});
