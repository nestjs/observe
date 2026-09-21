import { Controller, Get, Module, Param, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
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
 * HTTP request collection, end to end through a real Express-backed Nest app.
 *
 * The agent attaches by way of `httpAdapter.setOnRequestHook` /
 * `setOnResponseHook`, which only exist once the adapter has initialised - so
 * nothing here can be exercised without actually booting an app and issuing
 * real requests.
 */
describe("ObserveModule: HTTP collection", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(HttpTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    // `init()` rather than `listen()`: supertest binds an ephemeral port to the
    // underlying server itself, and the adapter's init hook - which is what
    // registers the request hooks - has already fired by then.
    await app.init();
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

  it("attaches the default header allow-list to a failed request, and nothing to a successful one", async () => {
    await request(app.getHttpServer())
      .get("/boom")
      .set("user-agent", "observe-int")
      .set("authorization", "Bearer should-never-leave")
      .expect(500);
    await request(app.getHttpServer())
      .get("/orders")
      .set("user-agent", "observe-int")
      .expect(200);

    const failed = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/boom",
    );
    expect(failed.request?.headers).toMatchObject({
      "user-agent": "observe-int",
    });
    expect(JSON.stringify(failed)).not.toContain("should-never-leave");
    expect(failed.request?.body).toBeUndefined();

    const succeeded = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/orders",
    );
    expect(succeeded.error).toBeUndefined();
    expect(succeeded.request).toBeUndefined();
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
