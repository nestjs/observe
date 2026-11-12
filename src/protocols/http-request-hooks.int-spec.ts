import {
  Controller,
  ForbiddenException,
  Get,
  INestApplication,
  Injectable,
  Module,
  Param,
  RequestMethod,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TracerService } from "../services/tracer.service.js";
import {
  createNodeAdapter,
  nestAtLeast,
  onPlatforms,
} from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

/** The adapter surface the application's hooks go through: public API. */
interface Hooks {
  setOnRequestHook(
    hook: (req: any, res: any, done: (err?: Error) => void) => unknown,
  ): void;
  setOnResponseHook(
    hook: (req: any, res: any, done?: () => void) => unknown,
  ): void;
  setOnRouteTriggered(
    hook: (method: RequestMethod, path: string) => void,
  ): void;
  getOnRouteTriggered():
    | ((method: RequestMethod, path: string) => void)
    | undefined;
}

/** What the application's hooks did, for the assertions below. */
const seen = {
  handled: 0,
  audit: [] as string[],
  routes: [] as string[],
  traceIds: [] as (string | null)[],
};

let tracer: TracerService | undefined;

/**
 * The application's request and response hooks: a gateway check that refuses
 * a caller without its key - with `done(err)`, or by rejecting - and an audit
 * line per response.
 */
function setRequestHooks(adapter: Hooks): void {
  adapter.setOnRequestHook((req, _res, done) => {
    const key = (req.headers ?? req.raw?.headers ?? {})["x-gateway-key"];
    seen.traceIds.push(tracer?.currentTraceId() ?? null);
    if (key === "reject") {
      return Promise.reject(new ForbiddenException("rejected"));
    }
    if (key !== "secret") {
      return done(new ForbiddenException("no gateway key"));
    }
    done();
  });
  adapter.setOnResponseHook((req, res, done) => {
    const url: string = req.url ?? req.raw?.url;
    seen.audit.push(`${url} ${res.statusCode}`);
    done?.();
  });
}

/** Where in the application the hooks above are set. */
type Placement = "a provider's constructor" | "main.ts, before listen()";
let placement: Placement;

@Injectable()
class GatewayHooks {
  constructor(adapterHost: HttpAdapterHost) {
    const adapter = adapterHost.httpAdapter as unknown as Hooks;
    adapter.setOnRouteTriggered(() => {
      seen.routes.push("first");
    });
    if (placement === "a provider's constructor") {
      setRequestHooks(adapter);
    }
  }
}

@Controller()
class InvoicesController {
  @Get("invoices/:id")
  find(@Param("id") id: string) {
    seen.handled++;
    return { id };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [InvoicesController],
  providers: [GatewayHooks],
})
class GatewayModule {}

/** Without the provider: `@nestjs/testing` has no adapter until compiled. */
@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [InvoicesController],
})
class TestingGatewayModule {}

type Platform = "express" | "node" | "fastify";

const cases = onPlatforms<Platform>(["express", "node", "fastify"]).flatMap(
  (platform) =>
    (
      ["a provider's constructor", "main.ts, before listen()"] as Placement[]
    ).map((where) => [platform, where] as const),
);

/**
 * An HTTP adapter keeps one request hook, one response hook and one route
 * hook, behind public setters, and the application may set them as well as
 * the agent: a gateway check, an audit line. Whichever was set second used to
 * be the only one left - the application's check switched off, or the agent's
 * tracing - without a word from either.
 */
describe.each(cases)(
  "ObserveModule: HTTP hooks the application set (%s, from %s)",
  (platform, where) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;
    let addRouteMetadata: ReturnType<typeof vi.spyOn>;

    const get = (path: string, key?: string) => {
      const pending = request(app.getHttpServer()).get(path).timeout(5000);
      return key ? pending.set("x-gateway-key", key) : pending;
    };

    beforeAll(async () => {
      placement = where;
      app = await NestFactory.create(
        GatewayModule,
        platform === "fastify"
          ? new FastifyAdapter()
          : platform === "node"
            ? await createNodeAdapter()
            : new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      const adapter = app.getHttpAdapter() as unknown as Hooks;
      if (where === "main.ts, before listen()") {
        setRequestHooks(adapter);
        // Chained onto the hook already there, read through the getter Nest's
        // router reads it from: the provider's, beside the agent's.
        const previous = adapter.getOnRouteTriggered();
        adapter.setOnRouteTriggered((method, path) => {
          previous?.(method, path);
          seen.routes.push("second");
        });
      }
      collected = collectSnapshots(app);
      tracer = app.get(TracerService);
      await app.listen(0, "127.0.0.1");
    });

    afterAll(async () => {
      tracer = undefined;
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      seen.handled = 0;
      seen.audit.length = 0;
      seen.routes.length = 0;
      seen.traceIds.length = 0;
      addRouteMetadata = vi.spyOn(
        OperationTraceRegistry.prototype,
        "addRouteMetadataToTrace",
      );
    });

    afterEach(() => {
      addRouteMetadata.mockRestore();
    });

    it("serves a request the application's hook lets through, and the agent records it", async () => {
      await get("/invoices/7", "secret").expect(200, { id: "7" });

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/invoices/:id",
      );
      expect(snapshot.attributes?.statusCode).toBe(200);
      // Inside the request's store: what it logs carries the trace.
      expect(seen.traceIds).toEqual([snapshot.traceId]);
      await waitFor(() => seen.audit.length === 1, 2000, "the audit line");
      expect(seen.audit).toEqual(["/invoices/7 200"]);
    });

    it("runs every route hook once, the agent's among them", async () => {
      await get("/invoices/8", "secret").expect(200);

      expect(seen.routes).toEqual(
        where === "main.ts, before listen()" ? ["first", "second"] : ["first"],
      );
      expect(addRouteMetadata).toHaveBeenCalledOnce();
    });

    it.each<[string, string | undefined]>([
      ["with done(err)", undefined],
      // A request hook's rejected promise reaches the request only from Nest
      // 12.1.3 (nestjs/nest#18110 for Express, #17997 for Fastify). Before
      // that the adapter drops the promise, and the request hangs with or
      // without the agent.
      ...(nestAtLeast("12.1.3")
        ? [["by rejecting", "reject"] as [string, string]]
        : []),
    ])(
      "refuses a request the application's hook refuses %s, leaving no trace open",
      async (_, key) => {
        const registry = app.get(OperationTraceRegistry);
        const open = () =>
          (registry as unknown as { traceSnapshots: Map<string, unknown> })
            .traceSnapshots.size;
        const before = open();

        await get("/invoices/9", key).expect(403);

        expect(seen.handled).toBe(0);
        await waitFor(() => seen.audit.length === 1, 2000, "the audit line");
        expect(seen.audit).toEqual(["/invoices/9 403"]);
        await waitFor(
          () => open() === before,
          2000,
          "the refused request's trace to be closed",
        );
      },
    );
  },
);

/**
 * `@nestjs/testing` attaches the adapter only once the testing module is
 * compiled, and offers no instance decorator: the agent takes the adapter's
 * hooks over from `HttpAdapterHost.init$`, which fires then.
 */
describe("ObserveModule: HTTP hooks the application set on a @nestjs/testing application", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TestingGatewayModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    setRequestHooks(app.getHttpAdapter() as unknown as Hooks);
    tracer = app.get(TracerService);
    await app.init();
  });

  afterAll(async () => {
    tracer = undefined;
    await app?.close();
  });

  beforeEach(() => {
    seen.handled = 0;
    seen.traceIds.length = 0;
  });

  it("runs the application's request hook, inside the agent's", async () => {
    await request(app.getHttpServer()).get("/invoices/7").expect(403);
    expect(seen.handled).toBe(0);

    await request(app.getHttpServer())
      .get("/invoices/7")
      .set("x-gateway-key", "secret")
      .expect(200, { id: "7" });
    // The agent opened the request's store before the application's hook ran.
    expect(seen.traceIds).toEqual([expect.any(String), expect.any(String)]);
  });
});
