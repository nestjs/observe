import {
  Controller,
  Get,
  INestApplication,
  Module,
  Param,
  Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { NestNodeApplication } from "@nestjs/platform-node";
import request from "supertest";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { createObserveModule } from "../observe.module.js";
import { createNodeAdapter, onPlatforms } from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

@Controller()
class OrdersController {
  @Get("orders/:id")
  findOne(@Param("id") id: string) {
    return { id };
  }
}

type Platform = "express" | "fastify" | "node";

/**
 * One CORS-enabled application per set of options, on any adapter, with a
 * middleware ahead of CORS unless `middleware` is false.
 */
async function bootApp(
  platform: Platform,
  overrides: Partial<ObserveOptions>,
  { middleware = true }: { middleware?: boolean } = {},
): Promise<{ app: INestApplication; collected: CollectedSnapshots }> {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [ObserveModule.forRoot(testObserveOptions(overrides))],
    controllers: [OrdersController],
  })
  class PreflightModule {}

  const app =
    platform === "express"
      ? await NestFactory.create<NestExpressApplication>(
          PreflightModule as Type<unknown>,
          { instrument: ObserveInstrument, logger: false },
        )
      : platform === "node"
        ? await NestFactory.create<NestNodeApplication>(
            PreflightModule as Type<unknown>,
            await createNodeAdapter(),
            { instrument: ObserveInstrument, logger: false },
          )
        : await NestFactory.create<NestFastifyApplication>(
            PreflightModule as Type<unknown>,
            new FastifyAdapter(),
            { instrument: ObserveInstrument, logger: false },
          );
  // Ahead of CORS, the way helmet or compression usually are, so the
  // preflight has a span when the adapter runs middleware for it - Express
  // does, Fastify from @nestjs/platform-fastify 12.1.3 answers it first.
  if (middleware) {
    app.use(function securityHeaders(
      _req: unknown,
      _res: unknown,
      next: () => void,
    ) {
      next();
    });
  }
  app.enableCors();
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

const preflight = (app: INestApplication) =>
  request(app.getHttpServer())
    .options("/orders/7?view=full")
    .set("Origin", "https://app.example.com")
    .set("Access-Control-Request-Method", "GET")
    .expect(204);

/**
 * CORS preflights over real HTTP on every adapter.
 *
 * A preflight is answered by the CORS middleware before any route matches,
 * so a traced one has no route and is reported under its URL - one "route"
 * per distinct URL for every call a browser client makes. Only a real app
 * shows that the request hook sees it at all, and that it is let through
 * untraced unless `http.tracePreflights` asks for it.
 */
describe.each<Platform>(onPlatforms(["express", "fastify", "node"]))(
  "ObserveModule: CORS preflights (%s)",
  (platform) => {
    describe("by default", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(platform, {}));
      });

      afterAll(async () => {
        await app?.close();
      });

      it("answers the preflight and reports nothing for it", async () => {
        await preflight(app);
        await request(app.getHttpServer())
          .get("/orders/7")
          .set("Origin", "https://app.example.com")
          .expect(200);

        // The GET was issued last; once it is in, the preflight never will be.
        await waitForSnapshot(
          collected,
          (item) => item.attributes?.method === "GET",
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(collected.items.map((item) => item.attributes?.method)).toEqual([
          "GET",
        ]);
      });
    });

    describe("with tracePreflights", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(platform, {
          http: { tracePreflights: true },
        }));
      });

      afterAll(async () => {
        await app?.close();
      });

      it("reports the preflight", async () => {
        await preflight(app);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.attributes?.method === "OPTIONS",
        );
        expect(snapshot.attributes?.statusCode).toBe(204);
      });
    });

    describe("with tracePreflights and nothing ahead of CORS", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;

      beforeAll(async () => {
        ({ app, collected } = await bootApp(
          platform,
          { http: { tracePreflights: true } },
          { middleware: false },
        ));
      });

      afterAll(async () => {
        await app?.close();
      });

      // No span to keep it: before, it was dropped as a request no handler
      // ran for - on every adapter here, and on Fastify from 12.1.3 even with
      // a middleware, since Nest answers the preflight there before any.
      it("reports the preflight without spans", async () => {
        await preflight(app);

        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.attributes?.method === "OPTIONS",
        );
        expect(snapshot.attributes?.statusCode).toBe(204);
        expect(snapshot.traces).toEqual([]);
      });
    });
  },
);
