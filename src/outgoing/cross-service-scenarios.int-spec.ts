import { BullModule, InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import {
  Controller,
  Get,
  INestApplication,
  Injectable,
  Module,
  Post,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { Job, Queue } from "bullmq";
import { get as httpGet } from "http";
import { connect } from "net";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedJobSnapshots,
  CollectedSnapshots,
  collectJobSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForJobSnapshot,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const redisReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: REDIS_HOST, port: REDIS_PORT });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

/** `node:http` can only be given a header from Node 22.12 on. */
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeHttpCanPropagate =
  nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);

const QUEUE_NAME = `observe-cross-service-${process.pid}`;
const UUID = /^[0-9a-f-]{36}$/;

// Three services, three agents, three async stores - as in three processes.
const storefront = createObserveModule();
const pricing = createObserveModule();
const ledger = createObserveModule();
const worker = createObserveModule();

let pricingUrl = "";
let ledgerUrl = "";

// --- storefront: Express, the edge --------------------------------------
@Controller()
class StorefrontController {
  @Get("quote")
  async quote() {
    const response = await fetch(`${pricingUrl}/price`);
    return response.json();
  }

  @Get("quote-twice")
  async quoteTwice() {
    // Two calls to one service under one trace - a fan-out, a retry.
    const [first, second] = await Promise.all([
      fetch(`${pricingUrl}/price`),
      fetch(`${pricingUrl}/price`),
    ]);
    return { first: await first.json(), second: await second.json() };
  }

  @Get("quote-legacy")
  quoteLegacy() {
    return new Promise((resolve, reject) => {
      httpGet(`${pricingUrl}/price`, (response) => {
        response.resume();
        response.once("end", () => resolve({ ok: true }));
      }).once("error", reject);
    });
  }

  @Get("quote-broken")
  async quoteBroken() {
    const response = await fetch(`${pricingUrl}/price-broken`);
    return { status: response.status };
  }
}

@Controller()
class OrdersController {
  constructor(@InjectQueue(QUEUE_NAME) private readonly queue: Queue) {}

  @Post("order")
  async order() {
    await this.queue.add("fulfil-order", {});
    return { ok: true };
  }
}

// The queue half is wired in only where Redis answers: BullMQ connects as
// the module boots, and would retry for the life of the suite otherwise.
@Module({
  imports: [
    ...(redisReachable
      ? [
          BullModule.forRoot({
            connection: { host: REDIS_HOST, port: REDIS_PORT },
          }),
          BullModule.registerQueue({ name: QUEUE_NAME }),
        ]
      : []),
    storefront.ObserveModule.forRoot(
      testObserveOptions({ serviceId: "storefront" }),
    ),
  ],
  controllers: [
    StorefrontController,
    ...(redisReachable ? [OrdersController] : []),
  ],
})
class StorefrontModule {}

// --- pricing: Fastify, the middle hop -------------------------------------
@Controller()
class PricingController {
  @Get("price")
  async price() {
    const response = await fetch(`${ledgerUrl}/balance`);
    return { price: 10, ledger: await response.json() };
  }

  @Get("price-broken")
  priceBroken() {
    throw new Error("pricing is down");
  }
}

@Module({
  imports: [
    pricing.ObserveModule.forRoot(testObserveOptions({ serviceId: "pricing" })),
  ],
  controllers: [PricingController],
})
class PricingModule {}

// --- ledger: Express, the far end -----------------------------------------
@Controller()
class LedgerController {
  @Get("balance")
  balance() {
    return { balance: 3 };
  }
}

@Module({
  imports: [
    ledger.ObserveModule.forRoot(testObserveOptions({ serviceId: "ledger" })),
  ],
  controllers: [LedgerController],
})
class LedgerModule {}

// --- worker: no HTTP at all, only the queue -------------------------------
@Injectable()
class WarehouseService {
  pick() {
    return "picked";
  }
}

@Processor(QUEUE_NAME)
class FulfilmentProcessor extends WorkerHost {
  constructor(private readonly warehouse: WarehouseService) {
    super();
  }

  async process(_job: Job) {
    return this.warehouse.pick();
  }
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: { host: REDIS_HOST, port: REDIS_PORT },
    }),
    BullModule.registerQueue({ name: QUEUE_NAME }),
    worker.ObserveModule.forRoot(testObserveOptions({ serviceId: "worker" })),
  ],
  providers: [WarehouseService, FulfilmentProcessor],
})
class WorkerModule {}

/**
 * One user action across every hop the agent can carry an id over, with the
 * adapters mixed: Express calls Fastify calls Express, and Express hands a
 * job to a worker that is a separate Nest application.
 *
 * Each service has its own `createObserveModule()`, so an id can only get
 * from one to the next the way it would between processes - in a header, or
 * in a job's options in Redis.
 */
describe("ObserveModule: one trace across several services", () => {
  let storefrontApp: NestExpressApplication;
  let pricingApp: NestFastifyApplication;
  let ledgerApp: NestExpressApplication;
  let workerApp: INestApplication | undefined;
  let storefrontSnapshots: CollectedSnapshots;
  let pricingSnapshots: CollectedSnapshots;
  let ledgerSnapshots: CollectedSnapshots;
  let workerJobs: CollectedJobSnapshots | undefined;

  beforeAll(async () => {
    ledgerApp = await NestFactory.create<NestExpressApplication>(LedgerModule, {
      instrument: ledger.ObserveInstrument,
      logger: false,
    });
    ledgerSnapshots = collectSnapshots(ledgerApp);
    const ledgerPort = await freePort();
    await ledgerApp.listen(ledgerPort);
    ledgerUrl = `http://127.0.0.1:${ledgerPort}`;

    pricingApp = await NestFactory.create<NestFastifyApplication>(
      PricingModule,
      new FastifyAdapter(),
      { instrument: pricing.ObserveInstrument, logger: false },
    );
    pricingSnapshots = collectSnapshots(pricingApp);
    const pricingPort = await freePort();
    await pricingApp.listen(pricingPort, "127.0.0.1");
    pricingUrl = `http://127.0.0.1:${pricingPort}`;

    if (redisReachable) {
      workerApp = await NestFactory.create(WorkerModule, {
        instrument: worker.ObserveInstrument,
        logger: false,
      });
      workerJobs = collectJobSnapshots(workerApp);
      await workerApp.init();
    }

    // Last, deliberately. The enqueue patch lives on BullMQ's one
    // `Queue.prototype`, and the newest agent's replaces the one before it -
    // in one process, the producer has to be the agent that holds it.
    storefrontApp = await NestFactory.create<NestExpressApplication>(
      StorefrontModule,
      { instrument: storefront.ObserveInstrument, logger: false },
    );
    storefrontSnapshots = collectSnapshots(storefrontApp);
    await storefrontApp.init();
  });

  afterAll(async () => {
    if (redisReachable) {
      await storefrontApp
        ?.get<Queue>(`BullQueue_${QUEUE_NAME}`)
        .obliterate({ force: true })
        .catch(() => undefined);
    }
    await storefrontApp?.close();
    await workerApp?.close();
    await pricingApp?.close();
    await ledgerApp?.close();
  });

  beforeEach(() => {
    storefrontSnapshots.clear();
    pricingSnapshots.clear();
    ledgerSnapshots.clear();
    workerJobs?.clear();
  });

  it("carries one id over two HTTP hops, Express to Fastify to Express", async () => {
    await request(storefrontApp.getHttpServer())
      .get("/quote")
      .set("x-request-id", "three-hop-trace-1")
      .expect(200);

    const edge = await waitForSnapshot(
      storefrontSnapshots,
      (item) => item.operationId === "/quote",
    );
    const middle = await waitForSnapshot(
      pricingSnapshots,
      (item) => item.operationId === "/price",
    );
    const far = await waitForSnapshot(
      ledgerSnapshots,
      (item) => item.operationId === "/balance",
    );

    expect(edge.traceId).toBe("three-hop-trace-1");
    expect(middle.traceId).toBe("three-hop-trace-1");
    expect(far.traceId).toBe("three-hop-trace-1");
  });

  it("carries an id the edge minted itself just the same", async () => {
    await request(storefrontApp.getHttpServer()).get("/quote").expect(200);

    const edge = await waitForSnapshot(
      storefrontSnapshots,
      (item) => item.operationId === "/quote",
    );
    const far = await waitForSnapshot(
      ledgerSnapshots,
      (item) => item.operationId === "/balance",
    );

    expect(edge.traceId).toMatch(UUID);
    expect(far.traceId).toBe(edge.traceId);
  });

  it("refuses an implausible inbound id at the edge, and propagates the one it minted instead", async () => {
    await request(storefrontApp.getHttpServer())
      .get("/quote")
      .set("x-request-id", "not a plausible id <script>")
      .expect(200);

    const edge = await waitForSnapshot(
      storefrontSnapshots,
      (item) => item.operationId === "/quote",
    );
    const middle = await waitForSnapshot(
      pricingSnapshots,
      (item) => item.operationId === "/price",
    );

    expect(edge.traceId).toMatch(UUID);
    expect(middle.traceId).toBe(edge.traceId);
  });

  it.runIf(nodeHttpCanPropagate)(
    "carries the id over a node:http call as well",
    async () => {
      await request(storefrontApp.getHttpServer())
        .get("/quote-legacy")
        .set("x-request-id", "node-http-hop-trace-1")
        .expect(200);

      const middle = await waitForSnapshot(
        pricingSnapshots,
        (item) => item.operationId === "/price",
      );
      expect(middle.traceId).toBe("node-http-hop-trace-1");
    },
  );

  it("keeps the id on a downstream failure: the caller's span completes, the callee's snapshot carries the error", async () => {
    await request(storefrontApp.getHttpServer())
      .get("/quote-broken")
      .set("x-request-id", "broken-hop-trace-1")
      .expect(200);

    const edge = await waitForSnapshot(
      storefrontSnapshots,
      (item) => item.operationId === "/quote-broken",
    );
    const middle = await waitForSnapshot(
      pricingSnapshots,
      (item) => item.operationId === "/price-broken",
    );

    expect(edge.traceId).toBe("broken-hop-trace-1");
    expect(edge.error).toBeUndefined();
    expect(middle.traceId).toBe("broken-hop-trace-1");
    expect(middle.attributes?.statusCode).toBe(500);
    expect((middle.error as { message?: string })?.message).toBe(
      "pricing is down",
    );
  });

  it("keeps concurrent requests apart: each downstream snapshot carries its own caller's id", async () => {
    const ids = ["fan-trace-1", "fan-trace-2", "fan-trace-3", "fan-trace-4"];
    await Promise.all(
      ids.map((id) =>
        request(storefrontApp.getHttpServer())
          .get("/quote")
          .set("x-request-id", id)
          .expect(200),
      ),
    );

    // Each service reports after it has answered, so the middle hop's last
    // snapshot can trail the far end's.
    await waitForSnapshot(
      ledgerSnapshots,
      () => ledgerSnapshots.items.length >= ids.length,
    );
    await waitForSnapshot(
      pricingSnapshots,
      () => pricingSnapshots.items.length >= ids.length,
    );
    expect(ledgerSnapshots.items.map((item) => item.traceId).sort()).toEqual(
      ids,
    );
    expect(pricingSnapshots.items.map((item) => item.traceId).sort()).toEqual(
      ids,
    );
  });

  it("reports both of two concurrent calls a service receives under one trace id", async () => {
    await request(storefrontApp.getHttpServer())
      .get("/quote-twice")
      .set("x-request-id", "twice-trace-1")
      .expect(200);

    await waitForSnapshot(
      pricingSnapshots,
      () => pricingSnapshots.items.length >= 2,
    );
    await waitForSnapshot(
      ledgerSnapshots,
      () => ledgerSnapshots.items.length >= 2,
    );
    for (const snapshot of [
      ...pricingSnapshots.items,
      ...ledgerSnapshots.items,
    ]) {
      expect(snapshot.traceId).toBe("twice-trace-1");
      expect(snapshot.traces).toHaveLength(1);
    }
    // The middle hop's two requests each kept their own outbound call.
    for (const snapshot of pricingSnapshots.items) {
      expect(snapshot.traces[0].children).toHaveLength(1);
    }
  });

  it.skipIf(!redisReachable)(
    "carries the id through a queue to a worker that is another Nest application",
    async () => {
      await request(storefrontApp.getHttpServer())
        .post("/order")
        .set("x-request-id", "queue-hop-trace-1")
        .expect(201);

      const job = await waitForJobSnapshot(
        workerJobs!,
        (item) => item.name === "fulfil-order",
        5_000,
      );
      expect(job.traceId).toBe("queue-hop-trace-1");
      expect(job.status).toBe("completed");
      expect(job.traces[0]).toMatchObject({
        className: "FulfilmentProcessor",
        methodKey: "process",
      });
      expect(job.traces[0].children?.[0]).toMatchObject({
        className: "WarehouseService",
        methodKey: "pick",
      });

      const edge = await waitForSnapshot(
        storefrontSnapshots,
        (item) => item.operationId === "/order",
      );
      expect(edge.traceId).toBe("queue-hop-trace-1");
    },
  );
});
