import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

let inventoryUrl = "";

// Two services, each with its own module and its own agent - as they would be
// in two processes. One `createObserveModule()` per service keeps their async
// stores apart, so nothing here can pass by sharing memory.
const gateway = createObserveModule();
const inventory = createObserveModule();

@Controller()
class GatewayController {
  @Get("orders")
  async orders() {
    const response = await fetch(`${inventoryUrl}/stock`);
    return { stock: await response.json() };
  }

  @Get("orders-private")
  async ordersPrivate() {
    const response = await fetch(`${inventoryUrl}/stock?private=1`);
    return { stock: await response.json() };
  }
}

@Controller()
class InventoryController {
  @Get("stock")
  stock() {
    return { available: 3 };
  }
}

@Module({
  imports: [
    gateway.ObserveModule.forRoot(
      testObserveOptions({
        serviceId: "gateway",
        outgoing: {
          http: {
            propagateTraceId: (url: string) => !url.includes("private=1"),
          },
        },
      }),
    ),
  ],
  controllers: [GatewayController],
})
class GatewayModule {}

@Module({
  imports: [
    inventory.ObserveModule.forRoot(
      testObserveOptions({ serviceId: "inventory" }),
    ),
  ],
  controllers: [InventoryController],
})
class InventoryModule {}

/**
 * One user action, two services, one trace - with no application code.
 *
 * The outgoing suite shows the header leaving; the HTTP suite shows a header
 * being adopted. This is the two together, which is the actual promise: the
 * gateway's `fetch()` carries its trace id out, and the inventory service -
 * a separate Nest application with its own agent - opens its request under
 * that id rather than minting one.
 */
describe("ObserveModule: a trace across two services", () => {
  let gatewayApp: NestExpressApplication;
  let inventoryApp: NestExpressApplication;
  let gatewaySnapshots: CollectedSnapshots;
  let inventorySnapshots: CollectedSnapshots;

  beforeAll(async () => {
    inventoryApp = await NestFactory.create<NestExpressApplication>(
      InventoryModule,
      { instrument: inventory.ObserveInstrument, logger: false },
    );
    inventorySnapshots = collectSnapshots(inventoryApp);
    const port = await freePort();
    await inventoryApp.listen(port);
    inventoryUrl = `http://127.0.0.1:${port}`;

    gatewayApp = await NestFactory.create<NestExpressApplication>(
      GatewayModule,
      { instrument: gateway.ObserveInstrument, logger: false },
    );
    gatewaySnapshots = collectSnapshots(gatewayApp);
    await gatewayApp.init();
  });

  afterAll(async () => {
    await gatewayApp?.close();
    await inventoryApp?.close();
  });

  beforeEach(() => {
    gatewaySnapshots.clear();
    inventorySnapshots.clear();
  });

  it("opens the downstream request under the caller's trace id", async () => {
    await request(gatewayApp.getHttpServer()).get("/orders").expect(200);

    const upstream = await waitForSnapshot(
      gatewaySnapshots,
      (item) => item.operationId === "/orders",
    );
    const downstream = await waitForSnapshot(
      inventorySnapshots,
      (item) => item.operationId === "/stock",
    );

    // Minted by the gateway - nothing came in with the test's own request.
    expect(upstream.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(downstream.traceId).toBe(upstream.traceId);
  });

  it("keeps the id to itself for the URLs the application excluded", async () => {
    await request(gatewayApp.getHttpServer())
      .get("/orders-private")
      .expect(200);

    const upstream = await waitForSnapshot(
      gatewaySnapshots,
      (item) => item.operationId === "/orders-private",
    );
    const downstream = await waitForSnapshot(
      inventorySnapshots,
      (item) => item.operationId === "/stock",
    );

    expect(downstream.traceId).not.toBe(upstream.traceId);
  });
});
