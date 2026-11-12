import {
  ArgumentsHost,
  CallHandler,
  CanActivate,
  Catch,
  ExecutionContext,
  INestApplication,
  Injectable,
  Logger,
  Module,
  NestInterceptor,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { WsAdapter } from "@nestjs/platform-ws";
import {
  BaseWsExceptionFilter,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { map, Subject, take, throwError } from "rxjs";
import { io } from "socket.io-client";
import { WebSocket } from "ws";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";

/** What the gateway's handlers, guard and filter saw, for the test to read. */
const seen = {
  /** Handlers and guards left waiting: their trace and how to go on. */
  waiting: [] as Array<{ traceId: string | null; goOn: () => void }>,
  /** The trace id the exception filter ran under, once per error. */
  filtered: [] as Array<string | null>,
  guardedRuns: 0,
};
/** What the `stream` handler's stream emits, when the test says so. */
let released = new Subject<void>();

@Injectable()
class PassThrough implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

@Injectable()
class HeldGuard implements CanActivate {
  constructor(private readonly tracer: TracerService) {}

  canActivate() {
    return new Promise<boolean>((resolve) =>
      seen.waiting.push({
        traceId: this.tracer.currentTraceId(),
        goOn: () => resolve(true),
      }),
    );
  }
}

@Catch()
class TracedFilter extends BaseWsExceptionFilter {
  constructor(private readonly tracer: TracerService) {
    super();
  }

  catch(exception: unknown, host: ArgumentsHost) {
    seen.filtered.push(this.tracer.currentTraceId());
    super.catch(exception, host);
  }
}

@WebSocketGateway()
class OrdersGateway {
  constructor(private readonly tracer: TracerService) {}

  @UseInterceptors(PassThrough)
  @SubscribeMessage("whoami")
  whoami() {
    return { event: "you-are", data: this.tracer.currentTraceId() };
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("ignored-whoami")
  ignoredWhoami() {
    return { event: "ignored-you-are", data: this.tracer.currentTraceId() };
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("report")
  async report() {
    await this.tracer.captureError(new Error("handled"));
    return { event: "reported", data: true };
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("explode")
  explode() {
    throw new Error("deliberate");
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("later")
  async later() {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { event: "later-done", data: true };
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("stream")
  stream() {
    return released.pipe(
      take(1),
      map(() => ({ event: "streamed", data: true })),
    );
  }

  @UseInterceptors(PassThrough)
  @SubscribeMessage("hold")
  hold() {
    return new Promise((resolve) =>
      seen.waiting.push({
        traceId: this.tracer.currentTraceId(),
        goOn: () => resolve({ event: "held", data: true }),
      }),
    );
  }

  @UseInterceptors(PassThrough)
  @UseGuards(HeldGuard)
  @SubscribeMessage("guarded")
  guarded() {
    seen.guardedRuns++;
    return { event: "guarded-done", data: true };
  }

  // No interceptor: the handler runs at once, its stream later.
  @UseFilters(TracedFilter)
  @SubscribeMessage("broken-stream")
  brokenStream() {
    return throwError(() => new Error("deliberate"));
  }
}

type Platform = "ws" | "socket.io";

interface TestClient {
  send(event: string, data?: unknown): void;
  next(event: string): Promise<unknown>;
  close(): void;
}

async function connectClient(
  platform: Platform,
  port: number,
): Promise<TestClient> {
  if (platform === "ws") {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const listeners = new Set<(event: string, data: unknown) => void>();
    socket.on("message", (raw: Buffer) => {
      const { event, data } = JSON.parse(raw.toString("utf8"));
      for (const listener of listeners) {
        listener(event, data);
      }
    });
    return {
      send: (event, data) => socket.send(JSON.stringify({ event, data })),
      next: (event) =>
        new Promise((resolve) => {
          const listener = (received: string, data: unknown) => {
            if (received === event) {
              listeners.delete(listener);
              resolve(data);
            }
          };
          listeners.add(listener);
        }),
      close: () => socket.close(),
    };
  }
  const socket = io(`http://127.0.0.1:${port}`, { transports: ["websocket"] });
  await new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(undefined));
    socket.once("connect_error", reject);
  });
  return {
    send: (event, data) => void socket.emit(event, data),
    next: (event) => new Promise((resolve) => socket.once(event, resolve)),
    close: () => void socket.close(),
  };
}

async function bootApp(platform: Platform, requestScopedInterceptor = false) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [
      ObserveModule.forRoot(
        testObserveOptions({
          ws: { ignore: (message) => message.pattern === "ignored-whoami" },
        }),
      ),
    ],
    providers: [
      PassThrough,
      HeldGuard,
      TracedFilter,
      OrdersGateway,
      ...(requestScopedInterceptor
        ? [
            {
              provide: APP_INTERCEPTOR,
              useClass: PassThrough,
              scope: Scope.REQUEST,
            },
          ]
        : []),
    ],
  })
  class WsInterceptorsModule {}

  const app = await NestFactory.create(WsInterceptorsModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  app.useWebSocketAdapter(
    platform === "ws" ? new WsAdapter(app) : new IoAdapter(app),
  );
  const collected = collectSnapshots(app);
  const port = await freePort();
  await app.listen(port);
  const client = await connectClient(platform, port);
  const registry = app.get(OperationTraceRegistry, { strict: false });
  return { app, collected, client, port, registry };
}

function spanNames(nodes: CompleteTraceEventNode[] | undefined): string[] {
  const names: string[] = [];
  const visit = (level: CompleteTraceEventNode[] | undefined) => {
    for (const node of level ?? []) {
      names.push(`${node.className}#${node.methodKey}`);
      visit(node.children);
    }
  };
  visit(nodes);
  return names;
}

/**
 * Gateway handlers behind an interceptor, on both platform adapters.
 *
 * With any interceptor bound, the chain `WsContextCreator.create` builds is
 * cold: Nest's proxy resolves to a stream once the guards have run, and the
 * adapter subscribes to it later, from the socket's own event. Everything
 * past the guards - the interceptors, the pipes, the handler, the exception
 * filter - runs at that subscription, and these cases ask whether it still
 * runs in the message's trace, and whether that trace ends when the handler
 * does rather than when the guards did.
 */
describe.each<Platform>(["ws", "socket.io"])(
  "ObserveModule: WebSocket handlers behind an interceptor (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;
    let client: TestClient;
    let port: number;
    let registry: OperationTraceRegistry;

    beforeAll(async () => {
      ({ app, collected, client, port, registry } = await bootApp(platform));
    });

    afterAll(async () => {
      client?.close();
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      seen.waiting.length = 0;
      seen.filtered.length = 0;
      seen.guardedRuns = 0;
    });

    const snapshotOf = (pattern: string) =>
      waitForSnapshot(
        collected,
        (item) => item.operationId === `OrdersGateway:${pattern}`,
      );

    it("runs the handler in its message's trace, under the interceptor, without blaming a missing instrument", async () => {
      const logged = vi.spyOn(
        (registry as unknown as { logger: Logger }).logger,
        "error",
      );
      const reply = client.next("you-are");
      client.send("whoami");

      const traceId = await reply;
      const snapshot = await snapshotOf("whoami");
      expect(traceId).toBe(snapshot.traceId);
      expect(spanNames(snapshot.traces as CompleteTraceEventNode[])).toContain(
        "OrdersGateway#whoami",
      );
      expect(logged).not.toHaveBeenCalled();
      logged.mockRestore();
    });

    it("records an error the handler reports, and answers as the handler chose to", async () => {
      const reply = Promise.race([
        client.next("reported"),
        client.next("exception"),
      ]);
      client.send("report");

      expect(await reply).toBe(true);
      const snapshot = await snapshotOf("report");
      expect(JSON.stringify(snapshot.traces)).toContain('"handled"');
    });

    it("reports a handler that throws with its error and status", async () => {
      client.send("explode");

      const snapshot = await snapshotOf("explode");
      expect((snapshot.error as { message?: string })?.message).toBe(
        "deliberate",
      );
      expect(snapshot.attributes?.statusCode).toBe(500);
    });

    it("keeps the trace open until the handler answers", async () => {
      const reply = client.next("later-done");
      client.send("later");

      expect(await reply).toBe(true);
      const snapshot = await snapshotOf("later");
      expect(snapshot.duration).toBeGreaterThanOrEqual(50);
    });

    it("reports a handler that returns a stream before the stream emits: the trace covers the handler, not the stream", async () => {
      released = new Subject<void>();
      const reply = client.next("streamed");
      client.send("stream");

      const snapshot = await snapshotOf("stream");
      expect(spanNames(snapshot.traces as CompleteTraceEventNode[])).toContain(
        "OrdersGateway#stream",
      );
      released.next();
      expect(await reply).toBe(true);
    });

    it("gives a message ws.ignore keeps out a store of its own, behind the interceptor too", async () => {
      const reply = client.next("ignored-you-are");
      client.send("ignored-whoami");

      expect(await reply).toEqual(expect.any(String));
      expect(collected.operationIds).not.toContain(
        "OrdersGateway:ignored-whoami",
      );
    });

    it("runs the exception filter of a handler whose stream fails in the message's store", async () => {
      client.send("broken-stream");

      const snapshot = await snapshotOf("broken-stream");
      await waitFor(() => seen.filtered.length === 1, 3_000, "the filter");
      expect(seen.filtered).toEqual([snapshot.traceId]);
    });

    it("drops the trace of a handler still waiting when its client leaves", async () => {
      const leaving = await connectClient(platform, port);
      leaving.send("hold");
      await waitFor(() => seen.waiting.length === 1, 3_000, "the handler");
      const [{ traceId, goOn }] = seen.waiting;

      // Open while the handler waits - not ended with the guards.
      expect(registry.hasTrace(traceId as string)).toBe(true);
      leaving.close();
      await waitFor(
        () => !registry.hasTrace(traceId as string),
        3_000,
        "the trace to be dropped",
      );

      goOn();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(collected.operationIds).not.toContain("OrdersGateway:hold");
    });

    it("drops the trace of a message whose client leaves while a guard holds it, and never runs the handler", async () => {
      const leaving = await connectClient(platform, port);
      leaving.send("guarded");
      await waitFor(() => seen.waiting.length === 1, 3_000, "the guard");
      const [{ traceId, goOn }] = seen.waiting;

      leaving.close();
      await waitFor(
        () => !registry.hasTrace(traceId as string),
        3_000,
        "the trace to be dropped",
      );

      goOn();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(seen.guardedRuns).toBe(0);
      expect(collected.operationIds).not.toContain("OrdersGateway:guarded");
    });
  },
);

/**
 * A request-scoped global interceptor makes Nest build the chain for every
 * message, through the patched `create`, rather than once per handler.
 */
describe.each<Platform>(["ws", "socket.io"])(
  "ObserveModule: WebSocket handlers behind a request-scoped global interceptor (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;
    let client: TestClient;

    beforeAll(async () => {
      ({ app, collected, client } = await bootApp(platform, true));
    });

    afterAll(async () => {
      client?.close();
      await app?.close();
    });

    it("runs each message's handler in that message's trace", async () => {
      const ids: unknown[] = [];
      for (let i = 0; i < 2; i++) {
        collected.clear();
        const reply = client.next("you-are");
        client.send("whoami");
        const traceId = await reply;
        const snapshot = await waitForSnapshot(
          collected,
          (item) => item.operationId === "OrdersGateway:whoami",
        );
        expect(traceId).toBe(snapshot.traceId);
        expect(
          spanNames(snapshot.traces as CompleteTraceEventNode[]),
        ).toContain("OrdersGateway#whoami");
        ids.push(traceId);
      }
      expect(ids[0]).not.toBe(ids[1]);
    });
  },
);
