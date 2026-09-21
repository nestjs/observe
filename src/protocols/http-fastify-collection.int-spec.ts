import { Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Controller()
class OrdersController {
  @Get("orders")
  findAll() {
    return [{ id: 1 }];
  }

  @Get("orders/:id")
  findOne(@Param("id") id: string) {
    return { id };
  }

  @Post("orders")
  create() {
    return { created: true };
  }

  @Get("boom")
  boom() {
    throw new Error("deliberate");
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersController],
})
class HttpTestModule {}

/**
 * The HTTP collection suite again, on Fastify.
 *
 * The agent never names an adapter - it relies on three hooks every adapter is
 * meant to implement - so the only evidence that Fastify honours them the way
 * Express does is the same assertions passing against it: the route template
 * as the operation id, the status on the error path, one snapshot per request.
 */
describe("ObserveModule: HTTP collection (Fastify)", () => {
  let app: NestFastifyApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(
      HttpTestModule,
      new FastifyAdapter(),
      { instrument: ObserveInstrument, logger: false },
    );
    collected = collectSnapshots(app);
    await app.init();
    // Fastify queues its plugins and routes until `ready()`; supertest talks to
    // the raw server, which would answer 404 to everything before that.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("collects a snapshot for a GET request", async () => {
    await request(app.getHttpServer()).get("/orders").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/orders",
    );

    expect(snapshot.protocol).toBe("http");
    expect(snapshot.attributes?.method).toBe("GET");
    expect(snapshot.attributes?.statusCode).toBe(200);
  });

  it("records a trace id and a duration", async () => {
    await request(app.getHttpServer()).get("/orders").expect(200);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/orders",
    );

    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.traceId.length).toBeGreaterThan(0);
    // Duration is measured, not defaulted - a zero here would mean the response
    // hook never ran and the trace was closed by something else.
    expect(snapshot.duration).toBeGreaterThanOrEqual(0);
    expect(snapshot.duration).toBeLessThan(5000);
  });

  it("keeps the route template rather than the concrete path", async () => {
    // The whole point of an operation id: /orders/1 and /orders/2 have to
    // aggregate together, or every id becomes its own endpoint in the charts.
    await request(app.getHttpServer()).get("/orders/42").expect(200);
    await request(app.getHttpServer()).get("/orders/99").expect(200);

    await waitForSnapshot(
      collected,
      (item) => item.attributes?.originalUrl === "/orders/42",
    );
    await waitForSnapshot(
      collected,
      (item) => item.attributes?.originalUrl === "/orders/99",
    );

    const ids = new Set(collected.operationIds);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe("/orders/:id");
  });

  it("distinguishes methods on the same path", async () => {
    await request(app.getHttpServer()).get("/orders").expect(200);
    await request(app.getHttpServer()).post("/orders").expect(201);

    await waitForSnapshot(
      collected,
      (item) => item.attributes?.method === "POST",
    );
    const get = collected.items.find(
      (item) => item.attributes?.method === "GET",
    );

    expect(get).toBeDefined();
    expect(collected.items).toHaveLength(2);
  });

  it("collects a failing request with its 500 status", async () => {
    // A request that throws is the one most worth having captured, so the
    // response hook has to fire on the error path too.
    await request(app.getHttpServer()).get("/boom").expect(500);

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/boom",
    );

    expect(snapshot.attributes?.statusCode).toBe(500);
  });

  it("collects one snapshot per request", async () => {
    await request(app.getHttpServer()).get("/orders").expect(200);
    await request(app.getHttpServer()).get("/orders").expect(200);
    await request(app.getHttpServer()).get("/orders").expect(200);

    // Poll until the third arrives, then assert nothing extra did - a
    // double-registered hook would show up here and nowhere else.
    await waitForSnapshot(collected, () => collected.items.length >= 3);
    expect(collected.items).toHaveLength(3);
  });
});
