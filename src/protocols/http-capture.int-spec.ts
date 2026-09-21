import { Body, Controller, Get, Module, Post } from "@nestjs/common";
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
import { RequestSnapshotEncoder } from "../encoders/request-snapshot.encoder.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Controller()
class CheckoutController {
  @Get("fast")
  fast() {
    return { ok: true };
  }

  @Get("slow")
  async slow() {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true };
  }

  @Post("pay")
  pay(@Body() _body: unknown) {
    throw new Error("card declined upstream");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        http: {
          capture: {
            headers: ["user-agent", "authorization", "x-tenant-id"],
            body: { maxBytes: 64 },
            slowerThanMs: 100,
          },
        },
      }),
    ),
  ],
  controllers: [CheckoutController],
})
class CaptureTestModule {}

/**
 * `http.capture` with everything switched on, end to end: which requests are
 * singled out, what of them is kept, and what that looks like on the wire.
 *
 * The defaults are covered by the HTTP collection suite - failed requests
 * only, allow-listed headers, no body. This is the opt-in surface, where a
 * mistake ships a customer's payload: the body, the slow threshold, and an
 * application naming a header it should not have.
 */
describe("ObserveModule: request capture", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(CaptureTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("captures a request that was only slow, and leaves the fast one alone", async () => {
    await request(app.getHttpServer())
      .get("/slow")
      .set("user-agent", "capture-int")
      .set("x-tenant-id", "acme")
      .expect(200);
    await request(app.getHttpServer())
      .get("/fast")
      .set("user-agent", "capture-int")
      .expect(200);

    const slow = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/slow",
    );
    expect(slow.error).toBeUndefined();
    expect(slow.request?.headers).toEqual({
      "user-agent": "capture-int",
      "x-tenant-id": "acme",
    });

    const fast = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/fast",
    );
    expect(fast.request).toBeUndefined();
  });

  it("redacts the body by key, cuts it to the cap, and masks a sensitive header the application named", async () => {
    await request(app.getHttpServer())
      .post("/pay")
      .set("user-agent", "capture-int")
      .set("authorization", "Bearer should-never-leave")
      .send({
        password: "hunter2",
        cardNumber: "4242424242424242",
        note: "x".repeat(200),
      })
      .expect(500);

    const failed = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/pay",
    );

    expect(failed.request?.headers?.authorization).toBe("[REDACTED]");
    expect(Buffer.byteLength(failed.request!.body!)).toBeLessThanOrEqual(64);
    expect(failed.request?.bodyTruncated).toBe(true);
    const everything = JSON.stringify(failed);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("should-never-leave");
    expect(everything).not.toContain("4242424242424242");
  });

  it("puts the capture on the wire as `rq`, beside the error and not inside it", async () => {
    await request(app.getHttpServer()).post("/pay").send({ a: 1 }).expect(500);

    const failed = await waitForSnapshot(
      collected,
      (item) => item.operationId === "/pay",
    );
    const encoded = RequestSnapshotEncoder.encode(failed) as Record<
      string,
      any
    >;

    expect(encoded.rq).toEqual(failed.request);
    expect(encoded.e).not.toHaveProperty("request");
    expect(encoded).not.toHaveProperty("request");
  });
});
