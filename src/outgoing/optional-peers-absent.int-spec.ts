import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { createServer, Server } from "http";
import { connect } from "net";
import pg from "pg";
import request from "supertest";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  captureOutput,
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

/** Every package the agent treats as an optional peer, asked for by name. */
const askedFor: string[] = [];

// The application below has none of the optional peers, as far as the agent
// can tell: the loader every integration goes through answers "not
// installed" for all of them. They are installed here - this repository's
// own suites need them - so absence has to be staged at the one seam they
// are all loaded through.
vi.mock("../utils/optional-peer.util.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../utils/optional-peer.util.js")>();
  return {
    ...original,
    loadOptionalPeer: (packageName: string) => {
      askedFor.push(packageName);
      return { installed: false };
    },
    loadAsResolvedBy: () => undefined,
  };
});

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

const { ObserveModule, ObserveInstrument } = createObserveModule();

let downstreamUrl = "";
let pool: pg.Pool | undefined;

@Injectable()
class ReportsService {
  async build() {
    const response = await fetch(`${downstreamUrl}/rates`);
    await response.text();
    if (pool) {
      await pool.query("SELECT 1 AS one");
    }
    return { ok: true };
  }
}

@Controller()
class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("report")
  report() {
    return this.reports.build();
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [ReportsController],
  providers: [ReportsService],
})
class BareModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

/**
 * An application with none of the optional peers: no database driver, no
 * queue, no gateways, no microservices, no GraphQL, no scheduler.
 *
 * Every one of those integrations is loaded through `loadOptionalPeer`, and
 * every one has to read "not installed" as the ordinary case - nothing
 * thrown, nothing logged - because it is the ordinary case: most services use
 * one or two of them.
 */
describe("ObserveModule: an application with no optional peers", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;
  let downstream: Server;
  let bootOutput: string[] = [];

  beforeAll(async () => {
    downstream = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await freePort();
    await new Promise<void>((resolve) => downstream.listen(port, resolve));
    downstreamUrl = `http://127.0.0.1:${port}`;

    const output = captureOutput();
    try {
      app = await NestFactory.create<NestExpressApplication>(BareModule, {
        instrument: ObserveInstrument,
        logger: ["warn", "error"],
      });
      collected = collectSnapshots(app);
      await app.init();
    } finally {
      output.restore();
    }
    bootOutput = output.lines;

    if (postgresReachable) {
      pool = new pg.Pool({ ...PG, max: 1 });
    }
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await app?.close();
    downstream.closeAllConnections();
    await new Promise((resolve) => downstream.close(resolve));
  });

  it("boots without a warning, having looked for each driver and found none", () => {
    expect(askedFor).toEqual(
      expect.arrayContaining(["pg", "mysql2", "mongodb"]),
    );
    expect(bootOutput.join("")).toBe("");
  });

  it("still traces requests and outbound HTTP, which need no peer, and records no query spans", async () => {
    await request(app.getHttpServer()).get("/report").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/report",
    );
    const traces = snapshot.traces as CompleteTraceEventNode[];
    expect(spansOf(traces, "ReportsService")).toHaveLength(1);
    expect(spansOf(traces, "http")).toHaveLength(1);
    // The driver works as it always did - it was simply never touched.
    expect(spansOf(traces, "pg")).toEqual([]);
  });
});
