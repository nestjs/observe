import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { APP_GUARD, NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { Throttle, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class SessionGuard implements CanActivate {
  canActivate() {
    return this.hasSession();
  }

  hasSession() {
    return true;
  }
}

/**
 * What applications write on top of the library's guard: the GraphQL recipe
 * of the throttler's documentation overrides `getRequestResponse`, others
 * pick their own tracker or skip some requests.
 */
@Injectable()
class AppThrottlerGuard extends ThrottlerGuard {
  protected override getRequestResponse(context: ExecutionContext) {
    return super.getRequestResponse(context);
  }

  protected override async getTracker(req: Record<string, any>) {
    return `tenant-${req.headers["x-tenant"] ?? "none"}`;
  }

  protected override async shouldSkip() {
    return false;
  }
}

@Controller()
@UseGuards(SessionGuard)
class HealthController {
  @Get("health")
  check() {
    return { ok: true };
  }

  @Throttle({ short: { limit: 1, ttl: 60_000 } })
  @Get("limited")
  limited() {
    return { ok: true };
  }
}

@Controller()
@UseGuards(AppThrottlerGuard)
class TenantController {
  @Get("tenant")
  find() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(testObserveOptions()),
    ThrottlerModule.forRoot([
      { name: "short", ttl: 1_000, limit: 100 },
      { name: "long", ttl: 60_000, limit: 1_000 },
    ]),
  ],
  controllers: [HealthController, TenantController],
  providers: [
    // As the throttler's documentation registers it: global, for every route.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    AppThrottlerGuard,
  ],
})
class ThrottlerTestModule {}

/** Every span of a tree, depth first, as `Class.method`. */
function spanNames(nodes: unknown): string[] {
  return ((nodes ?? []) as Array<Record<string, any>>).flatMap((node) => [
    `${node.className}.${node.methodKey}`,
    ...spanNames(node.children),
  ]);
}

const throttlerSpans = (names: string[]) =>
  names.filter((name) => /Throttler/.test(name));

/**
 * What a real application ships for `@nestjs/throttler`'s guard and in-memory
 * store resolved by the real injector, with two named throttlers, beside a
 * guard that is the control: the library's guard is one span, its store none,
 * and the guard an application wrote keeps all of its own.
 */
describe("ObserveModule: @nestjs/throttler", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;

  const namesOf = async (operationId: string) =>
    spanNames(
      (
        await waitForSnapshot(
          collected,
          (item) => item.operationId === operationId,
        )
      ).traces,
    );

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(
      ThrottlerTestModule,
      { instrument: ObserveInstrument, logger: false },
    );
    collected = collectSnapshots(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("ships `canActivate` alone for the library's guard, and nothing for its store", async () => {
    const response = await request(app.getHttpServer())
      .get("/health")
      .expect(200, { ok: true });

    // The guard still does its work: one set of headers per throttler.
    expect(response.headers["x-ratelimit-limit-short"]).toBe("100");
    expect(response.headers["x-ratelimit-limit-long"]).toBe("1000");
    expect(response.headers["x-ratelimit-remaining-long"]).toBeDefined();

    const names = await namesOf("/health");
    expect(throttlerSpans(names)).toEqual(["ThrottlerGuard.canActivate"]);
    expect(names).toEqual(
      expect.arrayContaining([
        "SessionGuard.canActivate",
        "SessionGuard.hasSession",
        "HealthController.check",
      ]),
    );
  });

  it("still refuses a request over the limit", async () => {
    await request(app.getHttpServer()).get("/limited").expect(200);
    collected.clear();

    const response = await request(app.getHttpServer())
      .get("/limited")
      .expect(429);
    expect(response.headers["retry-after-short"]).toBeDefined();

    const names = await namesOf("/limited");
    expect(throttlerSpans(names)).toEqual(["ThrottlerGuard.canActivate"]);
  });

  it("ships what an application's subclass overrides, and not what it inherits", async () => {
    await request(app.getHttpServer())
      .get("/tenant")
      .set("x-tenant", "acme")
      .expect(200, { ok: true });

    const names = await namesOf("/tenant");
    expect(throttlerSpans(names).sort()).toEqual(
      [
        // The global guard, then the route's own.
        "ThrottlerGuard.canActivate",
        "AppThrottlerGuard.canActivate",
        "AppThrottlerGuard.shouldSkip",
        // Once per named throttler, from the library's `handleRequest`.
        "AppThrottlerGuard.getRequestResponse",
        "AppThrottlerGuard.getRequestResponse",
        "AppThrottlerGuard.getTracker",
        "AppThrottlerGuard.getTracker",
      ].sort(),
    );
  });
});
