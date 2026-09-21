import {
  Body,
  CanActivate,
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
  ParseIntPipe,
  Post,
  Type,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import request from "supertest";
import { RequestSnapshotEncoder } from "../encoders/request-snapshot.encoder.js";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("not yours");
  }
}

@Injectable()
class AnonymousGuard implements CanActivate {
  canActivate(): boolean {
    throw new UnauthorizedException();
  }
}

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

  @Post("slow-post")
  async slowPost(@Body() _body: unknown) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true };
  }

  @Get("boom")
  boom() {
    throw new Error("deliberate");
  }

  @Post("pay")
  pay(@Body() _body: unknown) {
    throw new Error("card declined upstream");
  }

  @Get("forbidden")
  @UseGuards(DenyGuard)
  forbidden() {
    return { ok: true };
  }

  @Get("anonymous")
  @UseGuards(AnonymousGuard)
  anonymous() {
    return { ok: true };
  }

  @Get("items/:id")
  item(@Param("id", ParseIntPipe) id: number) {
    return { id };
  }

  @Get("health")
  health() {
    throw new Error("unhealthy, and ignored");
  }

  @Get("sampled-out")
  sampledOut() {
    throw new Error("failed, and sampled out");
  }
}

type Platform = "express" | "fastify";

/**
 * One application per set of options, on whichever adapter the suite is
 * running for. Each gets its own `createObserveModule()` - its own async
 * store - the way separate services would.
 */
async function bootApp(
  platform: Platform,
  overrides: Partial<ObserveOptions>,
  configure?: (app: INestApplication) => void,
): Promise<{ app: INestApplication; collected: CollectedSnapshots }> {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers: [CheckoutController],
    providers: [DenyGuard, AnonymousGuard],
  })
  class CaptureScenariosModule {}

  let app: INestApplication;
  if (platform === "express") {
    const expressApp = await NestFactory.create<NestExpressApplication>(
      CaptureScenariosModule as Type<unknown>,
      { instrument: ObserveInstrument, logger: false },
    );
    // Nest registers the JSON and urlencoded parsers itself; these are the
    // two an application adds when it takes text or binary uploads.
    expressApp.useBodyParser("text", { type: "text/plain" });
    expressApp.useBodyParser("raw", { type: "application/octet-stream" });
    app = expressApp;
  } else {
    const fastifyApp = await NestFactory.create<NestFastifyApplication>(
      CaptureScenariosModule as Type<unknown>,
      new FastifyAdapter(),
      { instrument: ObserveInstrument, logger: false },
    );
    fastifyApp
      .getHttpAdapter()
      .getInstance()
      .addContentTypeParser(
        "application/octet-stream",
        { parseAs: "buffer" },
        (_req: unknown, body: Buffer, done: (e: null, b: Buffer) => void) =>
          done(null, body),
      );
    app = fastifyApp;
  }
  configure?.(app);
  const collected = collectSnapshots(app);
  await app.init();
  if (platform === "fastify") {
    await (app as NestFastifyApplication)
      .getHttpAdapter()
      .getInstance()
      .ready();
  }
  return { app, collected };
}

/**
 * `http.capture`, scenario by scenario, over real HTTP on both adapters.
 *
 * The capture reads `req.headers` and `req.body` off whatever the adapter
 * hands the response hook - Express's `IncomingMessage` with whatever its
 * parsers left on it, Fastify's request wrapper with whatever its content-type
 * parsers produced. The unit spec covers the function; only a real request
 * shows what each adapter actually leaves there for a string, a buffer, a
 * form, and a body nobody parsed.
 */
describe.each<Platform>(["express", "fastify"])(
  "ObserveModule: request capture scenarios (%s)",
  (platform) => {
    describe("with headers, body and a slow threshold configured", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(platform, {
          http: {
            ignore: ["/health"],
            capture: {
              headers: [
                "User-Agent",
                "authorization",
                "x-tenant-id",
                "x-long",
                "referer",
                "content-type",
              ],
              body: { maxBytes: 256 },
              slowerThanMs: 100,
            },
          },
          tracesSampleRate: (_protocol, attributes) =>
            !String(attributes?.url).includes("sampled-out"),
        }));
      });

      afterAll(async () => {
        await app?.close();
      });

      beforeEach(() => collected.clear());

      const snapshotOf = (operationId: string) =>
        waitForSnapshot(collected, (item) => item.operationId === operationId);

      it("does not capture a fast successful request", async () => {
        await request(app.getHttpServer())
          .get("/fast")
          .set("x-tenant-id", "acme")
          .expect(200);

        const fast = await snapshotOf("/fast");
        expect(fast.error).toBeUndefined();
        expect(fast.request).toBeUndefined();
      });

      it("captures a slow successful request, headers and body, with no error beside them", async () => {
        await request(app.getHttpServer())
          .post("/slow-post")
          .set("x-tenant-id", "acme")
          .send({ plan: "pro" })
          .expect(201);

        const slow = await snapshotOf("/slow-post");
        expect(slow.error).toBeUndefined();
        expect(slow.duration).toBeGreaterThanOrEqual(100);
        expect(slow.request?.headers?.["x-tenant-id"]).toBe("acme");
        expect(slow.request?.body).toBe(JSON.stringify({ plan: "pro" }));
        expect(slow.request?.bodyTruncated).toBeUndefined();
      });

      it("captures a failed GET with its headers and no body at all", async () => {
        await request(app.getHttpServer())
          .get("/boom")
          .set("x-tenant-id", "acme")
          .expect(500);

        const failed = await snapshotOf("/boom");
        expect(failed.error).toBeDefined();
        expect(failed.request?.headers?.["x-tenant-id"]).toBe("acme");
        expect(failed.request).not.toHaveProperty("body");
        expect(failed.request).not.toHaveProperty("bodyTruncated");
      });

      it("matches header names case-insensitively and records them lower-cased", async () => {
        await request(app.getHttpServer())
          .get("/boom")
          .set("User-Agent", "capture-scenarios")
          .expect(500);

        const failed = await snapshotOf("/boom");
        expect(failed.request?.headers?.["user-agent"]).toBe(
          "capture-scenarios",
        );
        expect(failed.request?.headers).not.toHaveProperty("User-Agent");
      });

      it("records a named `authorization` header as redacted, and leaves out the headers nobody named", async () => {
        await request(app.getHttpServer())
          .get("/boom")
          .set("authorization", "Bearer should-never-leave")
          .set("cookie", "session=also-never-leaves")
          .set("x-forwarded-for", "203.0.113.7")
          .expect(500);

        const failed = await snapshotOf("/boom");
        expect(failed.request?.headers?.authorization).toBe("[REDACTED]");
        expect(failed.request?.headers).not.toHaveProperty("cookie");
        expect(failed.request?.headers).not.toHaveProperty("x-forwarded-for");
        const everything = JSON.stringify(failed);
        expect(everything).not.toContain("should-never-leave");
        expect(everything).not.toContain("also-never-leaves");
        expect(everything).not.toContain("203.0.113.7");
      });

      it("masks the query string of a referer", async () => {
        await request(app.getHttpServer())
          .get("/boom")
          .set(
            "referer",
            "https://app.example.com/reset?token=reset-secret&step=2",
          )
          .expect(500);

        const failed = await snapshotOf("/boom");
        const referer = String(failed.request?.headers?.referer);
        expect(referer).toContain("step=2");
        expect(referer).not.toContain("reset-secret");
      });

      it("bounds a very long header value", async () => {
        await request(app.getHttpServer())
          .get("/boom")
          .set("x-long", "v".repeat(4000))
          .expect(500);

        const failed = await snapshotOf("/boom");
        expect(failed.request?.headers?.["x-long"]).toHaveLength(512);
      });

      it("redacts sensitive keys of a JSON body, nested ones too, and keeps the rest", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .send({
            amount: 1200,
            password: "hunter2",
            card: { cardNumber: "4242424242424242", holder: "K M" },
            items: [{ sku: "a-1", api_key: "sk_live_never" }],
          })
          .expect(500);

        const failed = await snapshotOf("/pay");
        const body = JSON.parse(failed.request!.body!);
        expect(body.amount).toBe(1200);
        expect(body.password).toBe("[REDACTED]");
        expect(body.items[0].sku).toBe("a-1");
        expect(body.items[0].api_key).toBe("[REDACTED]");
        const everything = JSON.stringify(failed);
        expect(everything).not.toContain("hunter2");
        expect(everything).not.toContain("4242424242424242");
        expect(everything).not.toContain("sk_live_never");
        expect(failed.request?.bodyTruncated).toBeUndefined();
      });

      it("redacts before it cuts, so a secret past the cap never survives in part", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .send({
            note: "n".repeat(240),
            // Straddles the 256-byte cap: cutting first would ship its head.
            password: "straddling-secret-value",
            tail: "t".repeat(400),
          })
          .expect(500);

        const failed = await snapshotOf("/pay");
        expect(Buffer.byteLength(failed.request!.body!)).toBeLessThanOrEqual(
          256,
        );
        expect(failed.request?.bodyTruncated).toBe(true);
        expect(JSON.stringify(failed)).not.toContain("straddling");
      });

      it("counts the cap in bytes, not characters", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .send({ note: "ż".repeat(300) })
          .expect(500);

        const failed = await snapshotOf("/pay");
        expect(Buffer.byteLength(failed.request!.body!)).toBeLessThanOrEqual(
          256,
        );
        expect(failed.request?.bodyTruncated).toBe(true);
      });

      it("captures a text/plain body as the string it is, with secrets in it masked", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .set("content-type", "text/plain")
          .send("order=17 password=hunter2 done")
          .expect(500);

        const failed = await snapshotOf("/pay");
        expect(failed.request?.body).toContain("order=17");
        expect(failed.request?.body).not.toContain("hunter2");
      });

      it("captures a urlencoded form as its parsed fields, redacted by key", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .type("form")
          .send({ email: "k@example.com", password: "hunter2" })
          .expect(500);

        const failed = await snapshotOf("/pay");
        const body = JSON.parse(failed.request!.body!);
        expect(body.email).toBeDefined();
        expect(body.password).toBe("[REDACTED]");
        expect(JSON.stringify(failed)).not.toContain("hunter2");
      });

      it("records no body for a raw Buffer, only the headers", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .set("content-type", "application/octet-stream")
          .send(Buffer.from("binary-upload-contents"))
          .expect(500);

        const failed = await snapshotOf("/pay");
        expect(failed.request?.headers?.["content-type"]).toBe(
          "application/octet-stream",
        );
        expect(failed.request).not.toHaveProperty("body");
        expect(JSON.stringify(failed)).not.toContain("binary-upload-contents");
      });

      it.each([
        ["/forbidden", 403, "ForbiddenException", "DenyGuard"],
        ["/anonymous", 401, "UnauthorizedException", "AnonymousGuard"],
      ])(
        "captures a request a guard rejected (%s -> %i): the guard is the root span, so its exception is the operation's failure",
        async (path, status, cls, guard) => {
          await request(app.getHttpServer())
            .get(path)
            .set("x-tenant-id", "acme")
            .set("authorization", "Bearer rejected-token")
            .expect(status);

          const rejected = await snapshotOf(path);
          expect(rejected.attributes?.statusCode).toBe(status);
          expect((rejected.error as { cls?: string })?.cls).toBe(cls);
          expect(rejected.traces[0]).toMatchObject({
            className: guard,
            methodKey: "canActivate",
          });
          expect(rejected.request?.headers).toEqual({
            "x-tenant-id": "acme",
            authorization: "[REDACTED]",
          });
          expect(JSON.stringify(rejected)).not.toContain("rejected-token");
        },
      );

      it("captures a request a pipe rejected with 400, under its route template", async () => {
        await request(app.getHttpServer())
          .get("/items/not-a-number")
          .set("x-tenant-id", "acme")
          .expect(400);

        const rejected = await snapshotOf("/items/:id");
        expect(rejected.attributes?.statusCode).toBe(400);
        expect((rejected.error as { cls?: string })?.cls).toBe(
          "BadRequestException",
        );
        expect(rejected.request?.headers?.["x-tenant-id"]).toBe("acme");
      });

      it("does not capture the same route when the pipe lets the request through", async () => {
        await request(app.getHttpServer()).get("/items/7").expect(200);

        const accepted = await snapshotOf("/items/:id");
        expect(accepted.request).toBeUndefined();
      });

      it.runIf(platform === "express")(
        "records the headers of a multipart request nobody parsed, and none of its parts",
        async () => {
          await request(app.getHttpServer())
            .post("/pay")
            .field("note", "multipart-field-value")
            .attach("file", Buffer.from("multipart-file-contents"), "a.txt")
            .expect(500);

          const failed = await snapshotOf("/pay");
          expect(failed.request?.headers?.["content-type"]).toMatch(
            /^multipart\/form-data/,
          );
          expect(failed.request).not.toHaveProperty("body");
          const everything = JSON.stringify(failed);
          expect(everything).not.toContain("multipart-field-value");
          expect(everything).not.toContain("multipart-file-contents");
        },
      );

      it.runIf(platform === "fastify")(
        "reports no capture for a multipart request Fastify refuses with 415 before any handler runs",
        async () => {
          await request(app.getHttpServer())
            .post("/pay")
            .field("note", "multipart-field-value")
            .attach("file", Buffer.from("multipart-file-contents"), "a.txt")
            .expect(415);
          await request(app.getHttpServer()).get("/boom").expect(500);

          await snapshotOf("/boom");
          const everything = JSON.stringify(collected.items);
          expect(everything).not.toContain("multipart-field-value");
          expect(everything).not.toContain("multipart-file-contents");
          expect(collected.items.every((item) => !item.request?.body)).toBe(
            true,
          );
        },
      );

      it("emits the capture as `rq` on the wire, truncation flag included", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .set("x-tenant-id", "acme")
          .send({ note: "x".repeat(600) })
          .expect(500);

        const failed = await snapshotOf("/pay");
        const encoded = RequestSnapshotEncoder.encode(failed) as Record<
          string,
          any
        >;
        expect(encoded.rq.headers["x-tenant-id"]).toBe("acme");
        expect(encoded.rq.bodyTruncated).toBe(true);
        expect(Buffer.byteLength(encoded.rq.body)).toBeLessThanOrEqual(256);
        expect(encoded).not.toHaveProperty("request");
      });

      it("emits no `rq` for a request that was not captured", async () => {
        await request(app.getHttpServer()).get("/fast").expect(200);

        const fast = await snapshotOf("/fast");
        expect(RequestSnapshotEncoder.encode(fast)).not.toHaveProperty("rq");
      });

      it("reports nothing - capture included - for an ignored route or a sampled-out request, even when they fail", async () => {
        await request(app.getHttpServer()).get("/health").expect(500);
        await request(app.getHttpServer()).get("/sampled-out").expect(500);
        await request(app.getHttpServer()).get("/boom").expect(500);

        // `/boom` was issued last; once it is in, the other two never will be.
        await snapshotOf("/boom");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(collected.items).toHaveLength(1);
      });
    });

    describe("with capture: false", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(platform, {
          http: { capture: false },
        }));
      });

      afterAll(async () => {
        await app?.close();
      });

      it("records nothing of a failed request but the failure", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .set("user-agent", "capture-off")
          .send({ a: 1 })
          .expect(500);

        const failed = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/pay",
        );
        expect(failed.error).toBeDefined();
        expect(failed.request).toBeUndefined();
        expect(JSON.stringify(failed)).not.toContain("capture-off");
      });
    });

    describe("with headers: false and the body on", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(platform, {
          http: { capture: { headers: false, body: true } },
        }));
      });

      afterAll(async () => {
        await app?.close();
      });

      beforeEach(() => collected.clear());

      it("captures the body alone", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .set("user-agent", "headers-off")
          .send({ sku: "a-1" })
          .expect(500);

        const failed = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/pay",
        );
        expect(failed.request).toEqual({
          body: JSON.stringify({ sku: "a-1" }),
        });
      });

      it("captures nothing for a failed GET, which has neither", async () => {
        await request(app.getHttpServer()).get("/boom").expect(500);

        const failed = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/boom",
        );
        expect(failed.error).toBeDefined();
        expect(failed.request).toBeUndefined();
      });

      it("applies the default 2048-byte cap when `body` is just `true`", async () => {
        await request(app.getHttpServer())
          .post("/pay")
          .send({ note: "x".repeat(5000) })
          .expect(500);

        const failed = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/pay",
        );
        expect(Buffer.byteLength(failed.request!.body!)).toBe(2048);
        expect(failed.request?.bodyTruncated).toBe(true);
      });

      it("does not capture a merely slow request when no threshold is set", async () => {
        await request(app.getHttpServer())
          .post("/slow-post")
          .send({ a: 1 })
          .expect(201);

        const slow = await waitForSnapshot(
          collected,
          (item) => item.operationId === "/slow-post",
        );
        expect(slow.request).toBeUndefined();
      });
    });

    describe.runIf(platform === "express")(
      "behind a function middleware that calls next() synchronously",
      () => {
        let app: INestApplication;
        let collected: CollectedSnapshots;

        beforeAll(async () => {
          ({ app, collected } = await bootApp(platform, {}, (nest) =>
            nest.use(function tenantMiddleware(
              _req: unknown,
              _res: unknown,
              next: () => void,
            ) {
              next();
            }),
          ));
        });

        afterAll(async () => {
          await app?.close();
        });

        beforeEach(() => collected.clear());

        // `app.use(fn)` functions are instrumented, and one that calls
        // `next()` synchronously is still on the stack when a handler with no
        // guards or pipes runs - so the handler's span nests under the
        // middleware's and is no longer the root. Only a root span's error
        // becomes the snapshot's, and capture keys off that. The status code
        // still says 500; the error payload and the capture are what is lost.
        it("KNOWN GAP: a failed bodiless request is not captured, because the handler's span is nested under the middleware's", async () => {
          await request(app.getHttpServer()).get("/boom").expect(500);

          const failed = await waitForSnapshot(
            collected,
            (item) => item.operationId === "/boom",
          );
          expect(failed.attributes?.statusCode).toBe(500);
          expect(failed.traces[0]).toMatchObject({
            className: "Function",
            methodKey: "tenantMiddleware",
          });
          expect(failed.traces[0].children?.[0]).toMatchObject({
            className: "CheckoutController",
            methodKey: "boom",
            error: true,
          });
          expect(failed.error).toBeUndefined();
          expect(failed.request).toBeUndefined();
        });

        it("still captures a failed request with a body: the parser's async hop takes the handler off the middleware's stack", async () => {
          await request(app.getHttpServer())
            .post("/pay")
            .send({ a: 1 })
            .expect(500);

          const failed = await waitForSnapshot(
            collected,
            (item) => item.operationId === "/pay",
          );
          expect(failed.error).toBeDefined();
          expect(failed.request?.headers).toBeDefined();
        });
      },
    );
  },
);
