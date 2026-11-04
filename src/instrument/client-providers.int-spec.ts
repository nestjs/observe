import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { ClientProxy, ClientsModule, Transport } from "@nestjs/microservices";
import { Redis } from "ioredis";
import { connect } from "net";
import { lastValueFrom } from "rxjs";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  listenOnLoopback,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const REDIS_HOST = process.env.REDIS_HOST ?? "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

const redisReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: REDIS_HOST, port: REDIS_PORT });
  const finish = (up: boolean) => {
    socket.destroy();
    resolve(up);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

const { ObserveModule, ObserveInstrument } = createObserveModule();

const REDIS = "REDIS";
const CART_EVENTS = "CART_EVENTS";

@Injectable()
class CartCache {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async read(id: string) {
    await this.redis.set(`cart:${id}`, "3 items");
    return this.redis.get(`cart:${id}`);
  }
}

@Controller()
class CartController {
  constructor(
    private readonly cache: CartCache,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(CART_EVENTS) private readonly events: ClientProxy,
  ) {}

  @Get("cart/:id")
  async read(@Param("id") id: string) {
    const cart = await this.cache.read(id);
    await this.redis.expire(`cart:${id}`, 60);
    await lastValueFrom(this.events.emit("cart.read", { id }), {
      defaultValue: undefined,
    });
    return { cart };
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(testObserveOptions()),
    ClientsModule.register([
      {
        name: CART_EVENTS,
        transport: Transport.REDIS,
        options: { host: REDIS_HOST, port: REDIS_PORT },
      },
    ]),
  ],
  controllers: [CartController],
  providers: [
    CartCache,
    {
      provide: REDIS,
      useFactory: () =>
        new Redis({
          host: REDIS_HOST,
          port: REDIS_PORT,
          maxRetriesPerRequest: 1,
        }),
    },
  ],
})
class ClientProvidersTestModule {}

const spansOf = (
  nodes: CompleteTraceEventNode[],
  className: string,
): CompleteTraceEventNode[] =>
  nodes.flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children ?? [], className),
  ]);

const namesOf = (nodes: CompleteTraceEventNode[]) =>
  nodes.map((node) => `${node.className}.${node.methodKey}`);

/**
 * Clients a Nest application registers as providers - a Redis client from
 * a factory, a `ClientProxy` from `ClientsModule` - are recorded the way
 * every provider is: a span for each method called on them, under the
 * method that called it, with no instrumentation of the client library
 * itself. That is how most applications reach Redis and Kafka.
 */
describe.skipIf(!redisReachable)(
  "ObserveModule: client libraries registered as providers",
  () => {
    let app: NestExpressApplication;
    let url = "";
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      app = await NestFactory.create<NestExpressApplication>(
        ClientProvidersTestModule,
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      url = await listenOnLoopback(app);
    });

    afterAll(async () => {
      await app
        ?.get<Redis>(REDIS)
        .quit()
        .catch(() => undefined);
      await app?.close();
    });

    beforeEach(() => collected.clear());

    it("records each call on a Redis client and a ClientProxy, under the method that made it", async () => {
      const response = await fetch(`${url}/cart/42`);
      expect(await response.json()).toEqual({ cart: "3 items" });

      const snapshot = await waitForSnapshot(
        collected,
        (item) => item.operationId === "/cart/:id",
      );
      const traces = snapshot.traces as CompleteTraceEventNode[];
      const [handler] = spansOf(traces, "CartController");
      const [cache] = spansOf(traces, "CartCache");

      // The client's own calls, each its own span, where they were made.
      expect(namesOf(cache.children ?? [])).toEqual(["Redis.set", "Redis.get"]);
      expect(namesOf(handler.children ?? [])).toEqual([
        "CartCache.read",
        "Redis.expire",
        "ClientRedis.emit",
      ]);
    });
  },
);
