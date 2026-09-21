import {
  CanActivate,
  ConflictException,
  ExecutionContext,
  INestApplication,
  Injectable,
  Module,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { WsAdapter } from "@nestjs/platform-ws";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import { createServer, Server } from "http";
import { connect } from "net";
import pg from "pg";
import { from, map, timer } from "rxjs";
import { io } from "socket.io-client";
import { WebSocket } from "ws";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const PG = {
  host: process.env.PGHOST ?? "127.0.0.1",
  port: Number(process.env.PGPORT ?? 54321),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres-whisprr",
  database: process.env.PGDATABASE ?? "postgres",
};

const postgresReachable = await new Promise<boolean>((resolve) => {
  const socket = connect({ host: PG.host, port: PG.port });
  const finish = (reachable: boolean) => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});

let downstreamUrl = "";
let pool: pg.Pool | undefined;

@Injectable()
class MembersOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.switchToWs().getData() === "member") {
      return true;
    }
    throw new WsException("members only");
  }
}

@Injectable()
class RatesService {
  async lookup() {
    const response = await fetch(`${downstreamUrl}/rates`);
    await response.text();
    if (pool) {
      await pool.query("SELECT 'ws-literal-secret' AS note");
    }
    return "looked-up";
  }
}

@WebSocketGateway()
class DeskGateway {
  constructor(
    private readonly rates: RatesService,
    private readonly tracer: TracerService,
  ) {}

  @SubscribeMessage("refuse")
  refuse() {
    throw new WsException("not today");
  }

  @SubscribeMessage("decline")
  decline() {
    throw new ConflictException("already seated");
  }

  @SubscribeMessage("later")
  async later() {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { event: "later-done", data: "slept" };
  }

  @SubscribeMessage("reject-later")
  async rejectLater() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    throw new Error("rejected after a wait");
  }

  @SubscribeMessage("ticks")
  ticks() {
    return from([1, 2, 3]).pipe(map((tick) => ({ event: "tick", data: tick })));
  }

  @SubscribeMessage("slow-stream")
  slowStream() {
    return timer(60).pipe(map(() => ({ event: "streamed", data: "late" })));
  }

  @SubscribeMessage("vault")
  @UseGuards(MembersOnlyGuard)
  vault() {
    return { event: "vault-open", data: true };
  }

  @SubscribeMessage("square")
  square(@MessageBody(ParseIntPipe) value: number) {
    return { event: "squared", data: value * value };
  }

  @SubscribeMessage("lookup")
  async lookup() {
    return { event: "looked-up", data: await this.rates.lookup() };
  }

  @SubscribeMessage("whoami")
  whoami() {
    return { event: "you-are", data: this.tracer.currentTraceId() };
  }

  @SubscribeMessage("sampled-out")
  sampledOut() {
    return { event: "sampled-out-done", data: null };
  }
}

type Platform = "ws" | "socket.io";

/** One client API over both transports: send a message, await a named reply. */
interface TestClient {
  send(event: string, data?: unknown): void;
  next(event: string): Promise<unknown>;
  collect(event: string): unknown[];
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
    socket.on("message", (raw) => {
      const { event, data } = JSON.parse(String(raw));
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
      collect: (event) => {
        const seen: unknown[] = [];
        listeners.add((received, data) => {
          if (received === event) {
            seen.push(data);
          }
        });
        return seen;
      },
      close: () => socket.close(),
    };
  }

  const socket = io(`http://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(undefined));
    socket.once("connect_error", reject);
  });
  return {
    send: (event, data) => void socket.emit(event, data),
    next: (event) => new Promise((resolve) => socket.once(event, resolve)),
    collect: (event) => {
      const seen: unknown[] = [];
      socket.on(event, (data: unknown) => seen.push(data));
      return seen;
    },
    close: () => void socket.close(),
  };
}

async function bootApp(platform: Platform, ws: ObserveOptions["ws"]) {
  const { ObserveModule, ObserveInstrument } = createObserveModule();
  const sampled: Array<{ protocol: string; attributes: unknown }> = [];

  @Module({
    imports: [
      ObserveModule.forRoot(
        testObserveOptions({
          ws,
          tracesSampleRate: (protocol, attributes) => {
            sampled.push({ protocol, attributes });
            return attributes?.pattern !== "sampled-out";
          },
        }),
      ),
    ],
    providers: [RatesService, MembersOnlyGuard, DeskGateway],
  })
  class WsScenariosModule {}

  const app = await NestFactory.create(WsScenariosModule, {
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
  return { app, collected, client, sampled };
}

const spansOf = (
  nodes: CompleteTraceEventNode[] | undefined,
  className: string,
): CompleteTraceEventNode[] =>
  (nodes ?? []).flatMap((node) => [
    ...(node.className === className ? [node] : []),
    ...spansOf(node.children, className),
  ]);

/**
 * Gateway messages past the happy path, on both platform adapters: handlers
 * that refuse, wait, stream, sit behind a guard or a pipe, make outbound
 * calls, or ask which trace they are in.
 *
 * The agent wraps what `WsContextCreator.create` returns, so every one of
 * these is a question about that chain - where a guard's exception surfaces,
 * whether an observable's reply still goes out, when the trace closes for a
 * handler that answers later - and the answers are Nest's, not the agent's,
 * which is why they are asked of a running gateway.
 */
describe.each<Platform>(["ws", "socket.io"])(
  "ObserveModule: WebSocket gateway scenarios (%s)",
  (platform) => {
    let downstream: Server;

    beforeAll(async () => {
      downstream = createServer((_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      });
      const port = await freePort();
      await new Promise<void>((resolve) => downstream.listen(port, resolve));
      downstreamUrl = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await pool?.end().catch(() => undefined);
      pool = undefined;
      downstream.closeAllConnections();
      await new Promise((resolve) => downstream.close(resolve));
    });

    describe("with tracing on", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;
      let client: TestClient;
      let sampled: Array<{ protocol: string; attributes: unknown }>;

      beforeAll(async () => {
        ({ app, collected, client, sampled } = await bootApp(platform, {
          setAttributes: (message) => ({ pattern: message.pattern }),
        }));
        // After the app: the agent patches the driver from its constructor.
        if (postgresReachable) {
          pool = new pg.Pool({ ...PG, max: 2 });
        }
      });

      afterAll(async () => {
        client?.close();
        await app?.close();
      });

      beforeEach(() => collected.clear());

      const snapshotOf = (pattern: string) =>
        waitForSnapshot(
          collected,
          (item) => item.operationId === `DeskGateway:${pattern}`,
        );

      it("reports a WsException with its payload, counted as unhandled: it is not an IntrinsicException, which is the line the agent draws", async () => {
        const exception = client.next("exception");
        client.send("refuse");

        // Nest's filter still tells the client.
        expect(await exception).toMatchObject({ message: "not today" });
        const snapshot = await snapshotOf("refuse");
        expect(snapshot.protocol).toBe("ws");
        expect(snapshot.error).toMatchObject({
          cls: "WsException",
          message: "not today",
        });
        expect(snapshot.traces[0]).toMatchObject({
          className: "DeskGateway",
          methodKey: "refuse",
        });
        expect(snapshot.attributes?.statusCode).toBe(500);
      });

      it("reports an intrinsic exception thrown by a handler as handled, under its own 4xx", async () => {
        client.send("decline");

        const snapshot = await snapshotOf("decline");
        expect((snapshot.error as { cls?: string })?.cls).toBe(
          "ConflictException",
        );
        expect(snapshot.attributes?.statusCode).toBe(409);
      });

      it("keeps the trace open for a handler that answers later, and measures the wait", async () => {
        const reply = client.next("later-done");
        client.send("later");

        expect(await reply).toBe("slept");
        const snapshot = await snapshotOf("later");
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.duration).toBeGreaterThanOrEqual(50);
        expect(
          (snapshot.traces[0] as CompleteTraceEventNode).duration,
        ).toBeGreaterThanOrEqual(50);
      });

      it("reports a handler that rejects after a wait as an unhandled failure", async () => {
        client.send("reject-later");

        const snapshot = await snapshotOf("reject-later");
        expect(snapshot.attributes?.statusCode).toBe(500);
        expect((snapshot.error as { message?: string })?.message).toBe(
          "rejected after a wait",
        );
      });

      it("delivers every emission of an observable handler, under one snapshot", async () => {
        const ticks = client.collect("tick");
        client.send("ticks");

        await waitFor(() => ticks.length === 3, 3_000, "three ticks");
        expect(ticks).toEqual([1, 2, 3]);
        await snapshotOf("ticks");
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(
          collected.items.filter(
            (item) => item.operationId === "DeskGateway:ticks",
          ),
        ).toHaveLength(1);
      });

      it("reports an observable that emits later without waiting for it: the trace covers the handler, not the stream", async () => {
        const reply = client.next("streamed");
        client.send("slow-stream");

        const snapshot = await snapshotOf("slow-stream");
        expect(await reply).toBe("late");
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.traces[0]).toMatchObject({
          className: "DeskGateway",
          methodKey: "slowStream",
        });
      });

      it("reports a message a guard refused, with the guard as the root span and the handler never run", async () => {
        const exception = client.next("exception");
        client.send("vault", "stranger");

        expect(await exception).toMatchObject({ message: "members only" });
        const snapshot = await snapshotOf("vault");
        expect(snapshot.traces[0]).toMatchObject({
          className: "MembersOnlyGuard",
          methodKey: "canActivate",
        });
        expect(
          spansOf(snapshot.traces as CompleteTraceEventNode[], "DeskGateway"),
        ).toEqual([]);
        expect((snapshot.error as { cls?: string })?.cls).toBe("WsException");
      });

      it("reports a message a guard let through, guard first and handler after", async () => {
        const reply = client.next("vault-open");
        client.send("vault", "member");

        expect(await reply).toBe(true);
        const snapshot = await snapshotOf("vault");
        expect(snapshot.error).toBeUndefined();
        expect(
          snapshot.traces.map((span) => `${span.className}#${span.methodKey}`),
        ).toEqual(["MembersOnlyGuard#canActivate", "DeskGateway#vault"]);
      });

      it("reports a message a pipe rejected as failed, and one it accepted as not", async () => {
        client.send("square", "not-a-number");
        const rejected = await snapshotOf("square");
        expect(rejected.error).toBeDefined();
        expect(rejected.traces[0]).toMatchObject({
          className: "ParseIntPipe",
          methodKey: "transform",
        });
        expect(
          spansOf(rejected.traces as CompleteTraceEventNode[], "DeskGateway"),
        ).toEqual([]);

        collected.clear();
        const reply = client.next("squared");
        client.send("square", "7");
        expect(await reply).toBe(49);
        const accepted = await snapshotOf("square");
        expect(accepted.error).toBeUndefined();
      });

      it("nests outgoing spans under the service method a gateway handler called", async () => {
        const reply = client.next("looked-up");
        client.send("lookup");

        expect(await reply).toBe("looked-up");
        const snapshot = await snapshotOf("lookup");
        const [handler] = snapshot.traces as CompleteTraceEventNode[];
        expect(handler).toMatchObject({
          className: "DeskGateway",
          methodKey: "lookup",
        });
        const [service] = spansOf(handler.children, "RatesService");
        const calls = spansOf(service.children, "http");
        expect(calls).toHaveLength(1);
        expect(calls[0].methodKey).toBe(
          `GET ${downstreamUrl.replace("http://", "")}`,
        );
        if (postgresReachable) {
          const queries = spansOf(service.children, "pg");
          expect(queries).toHaveLength(1);
          expect(queries[0].tags?.["db.statement"]).toBe("SELECT ? AS note");
          expect(JSON.stringify(snapshot)).not.toContain("ws-literal-secret");
        }
      });

      it("exposes the message's trace id inside the handler, a new one for every message", async () => {
        const first = client.next("you-are");
        client.send("whoami");
        const firstId = await first;
        const firstSnapshot = await snapshotOf("whoami");
        collected.clear();

        const second = client.next("you-are");
        client.send("whoami");
        const secondId = await second;
        const secondSnapshot = await snapshotOf("whoami");

        expect(firstId).toBe(firstSnapshot.traceId);
        expect(secondId).toBe(secondSnapshot.traceId);
        expect(firstId).not.toBe(secondId);
      });

      it("asks the sampler as protocol `ws`, with the gateway and pattern, and reports nothing for a message it declines", async () => {
        const reply = client.next("sampled-out-done");
        client.send("sampled-out");
        // The handler runs either way.
        expect(await reply).toBeNull();

        const after = client.next("you-are");
        client.send("whoami");
        await after;
        await snapshotOf("whoami");

        expect(collected.operationIds).not.toContain("DeskGateway:sampled-out");
        expect(sampled).toContainEqual({
          protocol: "ws",
          attributes: { gateway: "DeskGateway", pattern: "sampled-out" },
        });
      });
    });

    describe("with ws.ignore rejecting every message", () => {
      let app: INestApplication;
      let collected: CollectedSnapshots;
      let client: TestClient;

      beforeAll(async () => {
        ({ app, collected, client } = await bootApp(platform, {
          ignore: () => true,
        }));
      });

      afterAll(async () => {
        client?.close();
        await app?.close();
      });

      it("switches gateway tracing off: handlers answer, fail and call out as before, and nothing is reported", async () => {
        const reply = client.next("looked-up");
        client.send("lookup");
        expect(await reply).toBe("looked-up");

        const exception = client.next("exception");
        client.send("refuse");
        expect(await exception).toMatchObject({ message: "not today" });

        const whoami = client.next("you-are");
        client.send("whoami");
        // Still a trace id of its own, for logs - just no trace.
        expect(await whoami).toEqual(expect.any(String));

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(collected.items).toEqual([]);
      });
    });
  },
);
