import { Controller, Get, Inject, Module } from "@nestjs/common";
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

// A native ES module namespace has no prototype, so no `constructor`. A
// `data:` module reaches Node's loader as it is, where a file in the repo
// would go through Vitest's transform.
const utilsUrl =
  "data:text/javascript,export const greet = (name) => `hello ${name}`";
const utilsNamespace: { greet: (name: string) => string } = await import(
  utilsUrl
);

@Controller()
class GreetController {
  constructor(@Inject("UTILS") private readonly utils: typeof utilsNamespace) {}

  @Get("greet")
  greet() {
    return { message: this.utils.greet("you") };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [GreetController],
  providers: [{ provide: "UTILS", useValue: utilsNamespace }],
})
class NamespaceProviderModule {}

describe("ObserveModule: a module namespace registered as a value provider", () => {
  let app: NestExpressApplication;

  afterAll(async () => {
    await app?.close();
  });

  it("serves a request that calls a method on the namespace", async () => {
    app = await NestFactory.create<NestExpressApplication>(
      NamespaceProviderModule,
      { instrument: ObserveInstrument, logger: false },
    );
    await app.init();

    await request(app.getHttpServer())
      .get("/greet")
      .expect(200, { message: "hello you" });
  });
});
