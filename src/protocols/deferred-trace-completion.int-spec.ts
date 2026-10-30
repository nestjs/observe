import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { NodeAdapter } from "@nestjs/platform-node";
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
class ProfileController {
  @Get("me")
  me() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        http: {
          // The usual shape, and the one that took the process down: an
          // anonymous request has no `req.user`.
          getUserId: (req) => req.user.id,
        },
      }),
    ),
  ],
  controllers: [ProfileController],
})
class DeferredCompletionTestModule {}

type Platform = "express" | "node";

/**
 * `getUserId` runs when the trace is completed, after the response has gone
 * out. A throw there used to surface as an unhandled rejection and
 * end the process; vitest fails the run on one, so without the guard these
 * tests fail even before their assertions do.
 */
describe.each<Platform>(["express", "node"])(
  "ObserveModule: deferred trace completion (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create(
        DeferredCompletionTestModule,
        platform === "node" ? new NodeAdapter() : new ExpressAdapter(),
        {
          instrument: ObserveInstrument,
          logger: false,
        },
      );
      app.use(
        (
          req: { headers: Record<string, string>; user?: { id: string } },
          _res: unknown,
          next: () => void,
        ) => {
          const userId = req.headers["x-user-id"];
          if (userId) {
            req.user = { id: userId };
          }
          next();
        },
      );
      collected = collectSnapshots(app);
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => collected.clear());

    it("completes the trace without a user id when getUserId throws", async () => {
      await request(app.getHttpServer()).get("/me").expect(200);
      await request(app.getHttpServer()).get("/me").expect(200);

      await vi.waitFor(() => expect(collected.items).toHaveLength(2));
      expect(collected.items.map((item) => item.userId)).toEqual([
        undefined,
        undefined,
      ]);
    });

    it("keeps the user id getUserId returns", async () => {
      await request(app.getHttpServer())
        .get("/me")
        .set("x-user-id", "user-123")
        .expect(200);

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/me",
      );
      expect(snapshot.userId).toBe("user-123");
    });
  },
);
