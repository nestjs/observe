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
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { firstValueFrom, map, switchMap } from "rxjs";
import request from "supertest";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const UUID = /^[0-9a-f-]{36}$/;

/**
 * Whether the installed `@nestjs/microservices` can carry packet metadata at
 * all. The agent feature-tests the same thing; the suite has to, because the
 * right outcome differs - one id across the hop where the framework can carry
 * it, two unrelated ids and no complaint where it cannot.
 */
const frameworkCarriesMetadata =
  typeof (ClientProxy.prototype as { setOnDispatchHook?: unknown })
    .setOnDispatchHook === "function";

const api = createObserveModule();
const math = createObserveModule();

// Bound at import time, because the client module is configured by a
// decorator that is evaluated then.
const TCP_PORT = await freePort();

@Controller()
class MathController {
  @MessagePattern("sum")
  sum(@Payload() data: number[]) {
    return data.reduce((total, value) => total + value, 0);
  }

  @EventPattern("audited")
  audited(_event: unknown) {
    // fire-and-forget
  }
}

@Module({
  imports: [math.ObserveModule.forRoot(testObserveOptions())],
  controllers: [MathController],
})
class MathModule {}

@Controller()
class ApiController {
  constructor(@Inject("MATH") private readonly client: ClientProxy) {}

  @Get("total")
  async total() {
    return { total: await firstValueFrom(this.client.send("sum", [1, 2, 3])) };
  }

  @Get("audit")
  async audit() {
    await firstValueFrom(this.client.emit("audited", { id: 1 }), {
      defaultValue: undefined,
    });
    return { ok: true };
  }
}

/**
 * Chains a second call onto the first one's reply, on a client nothing else
 * uses - so the request that opens its connection is known.
 */
@Controller()
class ChainedController {
  constructor(
    @Inject("MATH_CHAINED") private readonly client: ClientProxy,
    private readonly tracer: TracerService,
  ) {}

  @Get("chained")
  chained() {
    return this.client.send<number>("sum", [1, 2]).pipe(
      map(() => this.tracer.currentTraceId()),
      switchMap((seen) =>
        this.client
          .send<number>("sum", [3, 4])
          .pipe(map((total) => ({ seen, total }))),
      ),
    );
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
      {
        name: "MATH_CHAINED",
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: TCP_PORT },
      },
    ]),
  ],
  controllers: [ApiController, ChainedController],
})
class ApiModule {}

/**
 * An HTTP request that calls a microservice through an injected
 * `ClientProxy` - the path the agent's dispatch hook sits on.
 *
 * The client is a provider, so it is handed to the instance decorator, which
 * is where the agent looks for `setOnDispatchHook`. Whatever the framework
 * offers, the call has to go through, both sides have to report, and the
 * instrumented client has to behave like a client.
 */
describe("ObserveModule: a trace from HTTP into a microservice", () => {
  let apiApp: INestApplication;
  let mathApp: INestMicroservice;
  let apiSnapshots: CollectedSnapshots;
  let mathSnapshots: CollectedSnapshots;

  beforeAll(async () => {
    mathApp = await NestFactory.createMicroservice(MathModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: TCP_PORT },
      instrument: math.ObserveInstrument,
      logger: false,
    } as never);
    mathSnapshots = collectSnapshots(mathApp);
    await mathApp.listen();

    apiApp = await NestFactory.create(ApiModule, {
      instrument: api.ObserveInstrument,
      logger: false,
    });
    apiSnapshots = collectSnapshots(apiApp);
    await apiApp.init();
  });

  afterAll(async () => {
    await apiApp?.close();
    await mathApp?.close();
  });

  beforeEach(() => {
    apiSnapshots.clear();
    mathSnapshots.clear();
  });

  it("completes the call through an instrumented ClientProxy, and both sides report", async () => {
    const response = await request(apiApp.getHttpServer())
      .get("/total")
      .set("x-request-id", "rpc-hop-trace-1")
      .expect(200);

    expect(response.body).toEqual({ total: 6 });
    const http = await waitForSnapshot(
      apiSnapshots,
      (item) => item.operationId === "/total",
    );
    const rpc = await waitForSnapshot(
      mathSnapshots,
      (item) => item.operationId === "sum",
    );
    expect(http.traceId).toBe("rpc-hop-trace-1");
    expect(http.error).toBeUndefined();
    expect(rpc.protocol).toBe("TCP");
    expect(rpc.error).toBeUndefined();
  });

  it.runIf(frameworkCarriesMetadata)(
    "runs the handler under the caller's trace id, where the framework carries packet metadata",
    async () => {
      await request(apiApp.getHttpServer())
        .get("/total")
        .set("x-request-id", "rpc-hop-trace-2")
        .expect(200);

      const rpc = await waitForSnapshot(
        mathSnapshots,
        (item) => item.operationId === "sum",
      );
      expect(rpc.traceId).toBe("rpc-hop-trace-2");
    },
  );

  it.runIf(!frameworkCarriesMetadata)(
    "mints the handler an id of its own, and nothing else changes, where the framework has no dispatch hook or packet metadata",
    async () => {
      await request(apiApp.getHttpServer())
        .get("/total")
        .set("x-request-id", "rpc-hop-trace-2")
        .expect(200);

      const rpc = await waitForSnapshot(
        mathSnapshots,
        (item) => item.operationId === "sum",
      );
      expect(rpc.traceId).toMatch(UUID);
      expect(rpc.traceId).not.toBe("rpc-hop-trace-2");
    },
  );

  it.runIf(frameworkCarriesMetadata)(
    "carries on from a reply under the trace of the call that asked for it",
    async () => {
      // A client connects on first use, in the request that uses it first,
      // and Node delivers every reply from that connection in that request's
      // async context: what a later caller chained onto its own reply ran,
      // and sent its next packet, under the first request's trace id.
      await request(apiApp.getHttpServer())
        .get("/chained")
        .set("x-request-id", "opens-the-connection")
        .expect(200);
      const response = await request(apiApp.getHttpServer())
        .get("/chained")
        .set("x-request-id", "chains-a-call")
        .expect(200);

      expect(response.body).toEqual({ seen: "chains-a-call", total: 7 });
      await waitForSnapshot(
        mathSnapshots,
        () =>
          mathSnapshots.items.filter((item) => item.operationId === "sum")
            .length === 4,
      );
      expect(
        mathSnapshots.items
          .filter((item) => item.traceId === "chains-a-call")
          .map((item) => item.operationId),
      ).toEqual(["sum", "sum"]);
    },
  );

  it("sends an event through the same client without disturbing either trace", async () => {
    await request(apiApp.getHttpServer()).get("/audit").expect(200);

    const http = await waitForSnapshot(
      apiSnapshots,
      (item) => item.operationId === "/audit",
    );
    const event = await waitForSnapshot(
      mathSnapshots,
      (item) => item.operationId === "audited",
    );
    expect(http.error).toBeUndefined();
    expect(event.error).toBeUndefined();
    expect(event.traceId).toEqual(expect.any(String));
  });
});

type Packet = { pattern: string; metadata?: Record<string, string> };

/**
 * A client with the dispatch hook, the way a framework release that carries
 * packet metadata builds one: the hook is handed over once, and run against
 * every packet on its way out.
 */
@Injectable()
class HookedClient {
  private hook?: (packet: Packet) => void;

  setOnDispatchHook(hook: (packet: Packet) => void) {
    this.hook = hook;
  }

  dispatch(packet: Packet): Packet {
    this.hook?.(packet);
    return packet;
  }
}

const hooked = createObserveModule();

@Controller()
class DispatchController {
  constructor(private readonly client: HookedClient) {}

  @Get("dispatch")
  dispatch() {
    return this.client.dispatch({ pattern: "sum" });
  }

  @Get("dispatch-own-id")
  dispatchOwnId() {
    return this.client.dispatch({
      pattern: "sum",
      metadata: { "x-request-id": "caller-chose-this", tenant: "acme" },
    });
  }

  @Get("dispatch-other-metadata")
  dispatchOtherMetadata() {
    return this.client.dispatch({
      pattern: "sum",
      metadata: { tenant: "acme" },
    });
  }
}

@Module({
  imports: [hooked.ObserveModule.forRoot(testObserveOptions())],
  controllers: [DispatchController],
  providers: [HookedClient],
})
class HookedModule {}

/**
 * The other side of the feature test: a client that does offer
 * `setOnDispatchHook`, in a real application, so the hook the agent registers
 * runs inside a real request's async context.
 */
describe("ObserveModule: the microservice dispatch hook, where a client offers one", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(HookedModule, {
      instrument: hooked.ObserveInstrument,
      logger: false,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("stamps the request's trace id onto an outgoing packet", async () => {
    const response = await request(app.getHttpServer())
      .get("/dispatch")
      .set("x-request-id", "dispatch-trace-1")
      .expect(200);

    expect(response.body.metadata).toEqual({
      "x-request-id": "dispatch-trace-1",
    });
  });

  it("adds the id beside metadata the application set, and never over an id it chose", async () => {
    const beside = await request(app.getHttpServer())
      .get("/dispatch-other-metadata")
      .set("x-request-id", "dispatch-trace-2")
      .expect(200);
    const chosen = await request(app.getHttpServer())
      .get("/dispatch-own-id")
      .set("x-request-id", "dispatch-trace-3")
      .expect(200);

    expect(beside.body.metadata).toEqual({
      tenant: "acme",
      "x-request-id": "dispatch-trace-2",
    });
    expect(chosen.body.metadata).toEqual({
      "x-request-id": "caller-chose-this",
      tenant: "acme",
    });
  });

  it("leaves a packet dispatched outside any trace as it was", () => {
    const client = app.get(HookedClient);

    expect(client.dispatch({ pattern: "sum" })).toEqual({ pattern: "sum" });
  });
});

const hookedInterop = createObserveModule();

@Module({
  imports: [
    hookedInterop.ObserveModule.forRoot(
      testObserveOptions({ openTelemetry: true }),
    ),
  ],
  controllers: [DispatchController],
  providers: [HookedClient],
})
class HookedInteropModule {}

/**
 * With `openTelemetry` on, an outgoing packet also carries a W3C
 * `traceparent` in the trace its id names, for an OpenTelemetry SDK in the
 * receiving service to continue - see `traceparentToHandOn`.
 */
describe("ObserveModule: the microservice dispatch hook, with openTelemetry on", () => {
  // The W3C spec's own example, and the id Observe writes it as.
  const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
  const TRACE_ID_AS_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";
  const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(HookedInteropModule, {
      instrument: hookedInterop.ObserveInstrument,
      logger: false,
    });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("sends a traceparent in the request's trace beside its id", async () => {
    const response = await request(app.getHttpServer())
      .get("/dispatch")
      .set("traceparent", TRACEPARENT)
      .expect(200);

    expect(response.body.metadata).toEqual({
      "x-request-id": TRACE_ID_AS_UUID,
      traceparent: expect.stringMatching(
        new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`),
      ),
    });
  });

  it("sends none beside an id the application chose", async () => {
    const response = await request(app.getHttpServer())
      .get("/dispatch-own-id")
      .set("traceparent", TRACEPARENT)
      .expect(200);

    expect(response.body.metadata).toEqual({
      "x-request-id": "caller-chose-this",
      tenant: "acme",
    });
  });

  it("sends the id alone once the collector refuses the app's credentials", async () => {
    app.get(ObserveAgentSharedBuffer, { strict: false }).recordRefused();

    const response = await request(app.getHttpServer())
      .get("/dispatch")
      .set("x-request-id", "dispatch-trace-4")
      .expect(200);

    expect(response.body.metadata).toEqual({
      "x-request-id": "dispatch-trace-4",
    });
  });
});
