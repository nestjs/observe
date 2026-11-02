import {
  Controller,
  DynamicModule,
  Get,
  Inject,
  INestApplication,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
  WireSnapshot,
} from "./fake-collector.js";
import { listenOnLoopback } from "./observe-harness.js";
import {
  ReceivedRequest,
  snapshotAt,
  untilIngesting,
} from "./opentelemetry-e2e.js";

const INVENTORY_URL = Symbol("INVENTORY_URL");

@Injectable()
class InventoryClient {
  constructor(@Inject(INVENTORY_URL) private readonly inventoryUrl: string) {}

  async stock(id: string): Promise<ReceivedRequest> {
    const response = await fetch(`${this.inventoryUrl}/stock/${id}`);
    return (await response.json()) as ReceivedRequest;
  }
}

@Controller()
class OrdersController {
  constructor(private readonly inventory: InventoryClient) {}

  @Get("health")
  health() {
    return "ok";
  }

  @Get("orders/:id")
  order(@Param("id") id: string) {
    return this.inventory.stock(id);
  }
}

export interface OrdersServiceOptions {
  /** The service its `GET /orders/:id` asks for `/stock/:id`. */
  inventoryUrl: string;
  /** Modules the application imports beside Observe's - another tool's. */
  imports?: DynamicModule[];
}

export interface OrdersService {
  readonly app: INestApplication;
  /** Where it listens, on 127.0.0.1. */
  readonly url: string;
  /** What its agent's worker sends to. */
  readonly collector: FakeCollector;
  /** Waits for the snapshot of a request to `path` at the collector. */
  snapshotFor(path: string): Promise<WireSnapshot>;
  /**
   * Sends requests until the collector has taken a batch - OpenTelemetry
   * interop runs only from then on.
   */
  untilIngesting(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The Nest service the suites that run the agent beside another tracer put in
 * the middle of a request: `GET /orders/:id` asks the inventory service for
 * `/stock/:id` with `fetch` and answers with what that service received, and
 * the agent reports to a fake collector with `openTelemetry` on, as deployed.
 */
export async function startOrdersService(
  options: OrdersServiceOptions,
): Promise<OrdersService> {
  const collector = await startFakeCollector();
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [
      ...(options.imports ?? []),
      ObserveModule.forRoot({
        appKey: "e2e-key",
        appSecret: "e2e-secret",
        serviceId: "orders",
        endpoint: collector.url,
        // The agent's floor, so the first batch goes within a second.
        flushInterval: 1000,
        runtimeMetrics: false,
        forwardLogs: false,
        openTelemetry: true,
      }),
    ],
    controllers: [OrdersController],
    providers: [
      InventoryClient,
      { provide: INVENTORY_URL, useValue: options.inventoryUrl },
    ],
  })
  class OrdersModule {}

  const app = await NestFactory.create(OrdersModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  const url = await listenOnLoopback(app);

  return {
    app,
    url,
    collector,
    snapshotFor: (path) =>
      snapshotAt(
        collector,
        (snapshot) => snapshot.a?.ou === path,
        `the snapshot for ${path} at the collector`,
      ),
    untilIngesting: () => untilIngesting(app, url),
    async close() {
      await app.close();
      await collector.close();
    },
  };
}
