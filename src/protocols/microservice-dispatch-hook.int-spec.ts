import {
  Controller,
  Get,
  Inject,
  INestApplication,
  INestMicroservice,
  Injectable,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientsModule,
  Ctx,
  MessagePattern,
  Payload,
  TcpContext,
  Transport,
} from "@nestjs/microservices";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { freePort, testObserveOptions } from "../testing/observe-harness.js";

/**
 * Whether the installed `@nestjs/microservices` has the dispatch hook at all:
 * 12.0.4 and later. The agent feature-tests the same thing.
 */
const frameworkCarriesMetadata =
  typeof (ClientProxy.prototype as { setOnDispatchHook?: unknown })
    .setOnDispatchHook === "function";

const api = createObserveModule();
const math = createObserveModule();

// Bound at import time: the client module is configured by a decorator.
const TCP_PORT = await freePort();

/** Answers with the metadata each packet arrived with. */
@Controller()
class MathController {
  @MessagePattern("sum")
  sum(@Payload() data: number[], @Ctx() ctx: TcpContext) {
    return {
      total: data.reduce((total, value) => total + value, 0),
      metadata: ctx.getMetadata?.() ?? null,
    };
  }
}

@Module({
  imports: [math.ObserveModule.forRoot(testObserveOptions())],
  controllers: [MathController],
})
class MathModule {}

/** How often the application's dispatch hook ran. */
let dispatched = 0;

/**
 * The application's dispatch hook, set on the client it was injected: every
 * packet says which tenant it is for, and one pattern names its own trace.
 */
@Injectable()
class TenantMetadata {
  constructor(@Inject("MATH") client: ClientProxy) {
    client.setOnDispatchHook((packet) => {
      dispatched++;
      packet.metadata = {
        ...packet.metadata,
        "x-tenant-id": "acme",
        ...(Array.isArray(packet.data) && packet.data.length === 3
          ? { "x-request-id": "chosen-by-the-app" }
          : {}),
      };
    });
  }
}

@Controller()
class ApiController {
  constructor(
    // The alias: Nest hands the same client to the instance decorator again.
    @Inject("MATH_ALIAS") private readonly client: ClientProxy,
  ) {}

  @Get("total")
  total() {
    return this.client.send("sum", [1, 2]);
  }

  @Get("total-own-id")
  totalOwnId() {
    return this.client.send("sum", [1, 2, 3]);
  }
}

@Module({
  imports: [
    api.ObserveModule.forRoot(testObserveOptions()),
    ClientsModule.register([
      {
        name: "MATH",
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: TCP_PORT },
      },
    ]),
  ],
  controllers: [ApiController],
  providers: [TenantMetadata, { provide: "MATH_ALIAS", useExisting: "MATH" }],
})
class ApiModule {}

/**
 * A `ClientProxy` keeps one dispatch hook, behind a public setter, and Nest
 * describes the packet metadata it writes as the application's too - a
 * tenant, a locale. The agent set it on every client as Nest created it, and
 * a hook the application set on the client afterwards took the agent's out:
 * the trace no longer crossed the hop.
 */
describe.runIf(frameworkCarriesMetadata)(
  "ObserveModule: a dispatch hook the application set on its client",
  () => {
    let apiApp: INestApplication;
    let mathApp: INestMicroservice;

    beforeAll(async () => {
      mathApp = await NestFactory.createMicroservice(MathModule, {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: TCP_PORT },
        instrument: math.ObserveInstrument,
        logger: false,
      } as never);
      await mathApp.listen();

      apiApp = await NestFactory.create(ApiModule, {
        instrument: api.ObserveInstrument,
        logger: false,
      });
      await apiApp.init();
    });

    afterAll(async () => {
      await apiApp?.close();
      await mathApp?.close();
    });

    beforeEach(() => {
      dispatched = 0;
    });

    it("sends the application's metadata and the trace id, running its hook once", async () => {
      const response = await request(apiApp.getHttpServer())
        .get("/total")
        .set("x-request-id", "dispatch-hook-trace-1")
        .expect(200);

      expect(response.body).toEqual({
        total: 3,
        metadata: {
          "x-tenant-id": "acme",
          "x-request-id": "dispatch-hook-trace-1",
        },
      });
      expect(dispatched).toBe(1);
    });

    it("keeps an id the application's hook chose", async () => {
      const response = await request(apiApp.getHttpServer())
        .get("/total-own-id")
        .set("x-request-id", "dispatch-hook-trace-2")
        .expect(200);

      expect(response.body.metadata).toEqual({
        "x-tenant-id": "acme",
        "x-request-id": "chosen-by-the-app",
      });
    });
  },
);
