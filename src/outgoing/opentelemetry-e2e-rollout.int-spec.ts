import {
  Controller,
  Get,
  INestApplication,
  Module,
  Param,
  Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import { listenOnLoopback } from "../testing/observe-harness.js";
import {
  asUuid,
  serverSpanFrom,
  snapshotAt,
  untilIngesting,
} from "../testing/opentelemetry-e2e.js";
import {
  OpenTelemetryService,
  startOpenTelemetryService,
} from "../testing/opentelemetry-service.js";
import { OtlpReceiver, startOtlpReceiver } from "../testing/otlp-receiver.js";

let stockUrl = "";

@Controller()
class CheckoutController {
  @Get("health")
  health() {
    return "ok";
  }

  @Get("checkout/:id")
  async checkout(@Param("id") id: string) {
    const response = await fetch(`${stockUrl}/stock/${id}`);
    return { stock: await response.text() };
  }
}

@Controller()
class StockController {
  @Get("health")
  health() {
    return "ok";
  }

  @Get("stock/:id")
  stock() {
    return "3";
  }
}

/** A Nest service running the agent, reporting to a collector of its own. */
async function bootService(
  serviceId: string,
  controller: Type,
  openTelemetry: boolean,
) {
  const collector = await startFakeCollector();
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [
      ObserveModule.forRoot({
        appKey: "e2e-key",
        appSecret: "e2e-secret",
        serviceId,
        endpoint: collector.url,
        flushInterval: 1000,
        runtimeMetrics: false,
        forwardLogs: false,
        openTelemetry,
      }),
    ],
    controllers: [controller],
  })
  class ServiceModule {}

  const app = await NestFactory.create(ServiceModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  const url = await listenOnLoopback(app);
  await untilIngesting(app, url);
  return { app, url, collector };
}

interface Service {
  app: INestApplication;
  url: string;
  collector: FakeCollector;
}

let otlp: OtlpReceiver;

beforeAll(async () => {
  otlp = await startOtlpReceiver();
});

afterAll(async () => {
  await otlp?.close();
});

/**
 * Two Nest services running the agent, one calling the other, behind a
 * gateway instrumented with OpenTelemetry - while a team turns
 * `openTelemetry` on one service at a time:
 *
 *   client → gateway (OpenTelemetry) → checkout (Nest + Observe) → stock (Nest + Observe)
 *
 * Whichever of the two has it on, the request stays one trace in Observe:
 * a service with it off still sends and reads `x-request-id`, and one with it
 * on still reads `x-request-id` when no `traceparent` comes, and sends the
 * trace id it settled on as `x-request-id` too.
 */
describe.each([
  ["on in front, off behind", true, false],
  ["off in front, on behind", false, true],
  ["on in both", true, true],
])("openTelemetry %s", (_, frontOn, backOn) => {
  // The receiver is shared with the other suites here.
  const id = `${frontOn ? "on" : "off"}-${backOn ? "on" : "off"}`;
  let stock: Service;
  let checkout: Service;
  let gateway: OpenTelemetryService;

  beforeAll(async () => {
    stock = await bootService("stock", StockController, backOn);
    stockUrl = stock.url;
    checkout = await bootService("checkout", CheckoutController, frontOn);
    gateway = await startOpenTelemetryService({
      name: "gateway",
      otlp,
      next: checkout.url,
    });
  }, 60_000);

  afterAll(async () => {
    await gateway?.stop();
    for (const service of [checkout, stock]) {
      await service?.app.close();
      await service?.collector.close();
    }
  });

  it("reports the request under one trace id in both services", async () => {
    const response = await fetch(`${gateway.url}/checkout/${id}`);
    expect(response.status).toBe(200);

    const { traceId } = await serverSpanFrom(
      () => otlp.spans,
      "gateway",
      `/checkout/${id}`,
    );
    const front = await snapshotAt(
      checkout.collector,
      (snapshot) => snapshot.a?.ou === `/checkout/${id}`,
      "the checkout service's snapshot",
    );
    const back = await snapshotAt(
      stock.collector,
      (snapshot) => snapshot.a?.ou === `/stock/${id}`,
      "the stock service's snapshot",
    );

    expect(back.ti).toBe(front.ti);
    if (frontOn) {
      expect(front.ti).toBe(asUuid(traceId));
    } else {
      // With it off, the gateway's traceparent goes unread, as before.
      expect(front.ti[14]).toBe("7");
    }
    expect(checkout.collector.violations).toEqual([]);
    expect(stock.collector.violations).toEqual([]);
  });
});
