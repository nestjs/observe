import { Controller, Get, Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ClsModule, ClsService } from "nestjs-cls";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { testObserveOptions } from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Controller()
class StatusController {
  constructor(private readonly cls: ClsService) {}

  @Get("status")
  status() {
    return { ok: true, hasRequestId: typeof this.cls.getId() === "string" };
  }
}

@Module({
  imports: [
    // Registers the CLS_REQ / CLS_RES proxy providers in strict mode - their
    // `get` trap throws ProxyProviderNotResolvedException for any property
    // not on a small allowlist whenever no CLS context is active, and
    // bootstrap always runs outside one.
    ClsModule.forRoot({
      global: true,
      middleware: { mount: true, generateId: true },
    }),
    ObserveModule.forRoot(testObserveOptions()),
  ],
  controllers: [StatusController],
})
class ClsTestModule {}

/**
 * The exact scenario of nestjs/nest#17553, end to end through the real
 * injector: `nestjs-cls` next to the observe module. The container hands
 * *every* provider - the strict CLS proxies included - to the instance
 * decorator, whose structural inspection used to read `decorate` on them and
 * crash the whole bootstrap.
 */
describe("ObserveModule: bootstrap alongside nestjs-cls proxy providers", () => {
  let app: NestExpressApplication;

  afterAll(async () => {
    await app?.close();
  });

  it("boots with the strict CLS proxy providers registered", async () => {
    app = await NestFactory.create<NestExpressApplication>(ClsTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    await app.init();
  });

  it("serves requests with a working CLS context", async () => {
    // Not just alive: the CLS middleware still does its job, so skipping the
    // uninspectable proxies cost nothing but their own instrumentation.
    await request(app.getHttpServer()).get("/status").expect(200, {
      ok: true,
      hasRequestId: true,
    });
  });
});

/** A request object in the style of `got`: a promise that also has methods. */
@Injectable()
class HttpClientLikeProvider {
  get() {
    return Object.assign(Promise.resolve("raw"), {
      json: async () => ({ ok: true }),
    });
  }
}

@Controller()
class UpstreamController {
  constructor(private readonly client: HttpClientLikeProvider) {}

  @Get("upstream")
  upstream() {
    return this.client.get().json();
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [UpstreamController],
  providers: [HttpClientLikeProvider],
})
class PromiseMembersTestModule {}

describe("ObserveModule: a provider that returns a promise with extra members", () => {
  let app: NestExpressApplication;

  afterAll(async () => {
    await app?.close();
  });

  it("lets the caller use the members of the returned promise", async () => {
    app = await NestFactory.create<NestExpressApplication>(
      PromiseMembersTestModule,
      { instrument: ObserveInstrument, logger: false },
    );
    await app.init();

    await request(app.getHttpServer()).get("/upstream").expect(200, {
      ok: true,
    });
  });
});
