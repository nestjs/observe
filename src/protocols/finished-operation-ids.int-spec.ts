import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer, IncomingHttpHeaders, Server } from "http";
import { AsyncResource } from "node:async_hooks";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  listenOnLoopback,
  testObserveOptions,
} from "../testing/observe-harness.js";
import { OPERATION_GRACE_MS } from "../utils/operation-state.util.js";

let downstreamUrl = "";

/**
 * What a flush or retry interval a request arms lazily does later: it runs
 * in that request's async context for the life of the process.
 */
let armed:
  | { traceId: () => string | null; call: () => Promise<void> }
  | undefined;

@Controller()
class InventoryController {
  constructor(private readonly tracer: TracerService) {}

  @Get("arm")
  arm() {
    armed ??= {
      traceId: AsyncResource.bind(() => this.tracer.currentTraceId()),
      call: AsyncResource.bind(async () => {
        const response = await fetch(`${downstreamUrl}/sync`);
        await response.text();
      }),
    };
    return { traceId: this.tracer.currentTraceId() };
  }
}

/**
 * A request's async store outlives it in whatever it left running. Its trace
 * id is handed on for a grace period after the request ends - an email sent
 * after the response still belongs to it - and not past that, so a timer it
 * armed does not label the rest of the process's life with its id.
 */
describe("ObserveModule: trace ids of a finished operation", () => {
  let app: INestApplication;
  let downstream: Server;
  const received: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    downstream = createServer((req, res) => {
      received.push(req.headers);
      res.end("ok");
    });
    downstreamUrl = await listenOnLoopback(downstream);

    const { ObserveModule, ObserveInstrument } = createObserveModule();
    @Module({
      imports: [ObserveModule.forRoot(testObserveOptions())],
      controllers: [InventoryController],
    })
    class InventoryModule {}
    app = await NestFactory.create(InventoryModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app?.close();
    downstream.closeAllConnections();
    await new Promise((resolve) => downstream.close(resolve));
  });

  it("hands a finished request's id on for the grace period, and not past it", async () => {
    const { body } = await request(app.getHttpServer()).get("/arm").expect(200);
    const traceId = (body as { traceId: string }).traceId;
    expect(traceId).toEqual(expect.any(String));

    // Just after the response: still the request's own work.
    expect(armed!.traceId()).toBe(traceId);
    await armed!.call();
    expect(received.at(-1)?.["x-request-id"]).toBe(traceId);

    // Long after it.
    const later = performance.now() + OPERATION_GRACE_MS + 1_000;
    vi.spyOn(performance, "now").mockReturnValue(later);
    try {
      expect(armed!.traceId()).toBeNull();
      await armed!.call();
      expect(received.at(-1)?.["x-request-id"]).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
