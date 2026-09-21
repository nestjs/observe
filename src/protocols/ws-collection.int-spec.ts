import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { WebSocket } from "ws";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

@Injectable()
class RoomsService {
  join(room: string) {
    return `joined:${room}`;
  }
}

@WebSocketGateway()
class ChatGateway {
  constructor(private readonly rooms: RoomsService) {}

  @SubscribeMessage("join")
  join(@MessageBody() room: string) {
    return { event: "joined", data: this.rooms.join(room) };
  }

  @SubscribeMessage("ping")
  ping() {
    return { event: "pong", data: null };
  }

  @SubscribeMessage("explode")
  explode() {
    throw new Error("deliberate");
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        ws: {
          tags: { environment: "test" },
          ignore: (message) => message.pattern === "ping",
          getUserId: (message) =>
            message.data === "lobby" ? "u-1" : undefined,
        },
      }),
    ),
  ],
  providers: [RoomsService, ChatGateway],
})
class WsTestModule {}

/**
 * Gateway message collection, end to end over a real socket.
 *
 * The agent patches `WsContextCreator.prototype.create`, and Nest builds each
 * gateway's handlers through it while the application initialises - so only
 * a booted app with a connected client shows the patch landed in time and that
 * the wrapped handler still answers.
 */
describe("ObserveModule: WebSocket gateway collection", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;
  let client: WebSocket;

  const send = (event: string, data?: unknown) =>
    client.send(JSON.stringify({ event, data }));

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(WsTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    app.useWebSocketAdapter(new WsAdapter(app));
    collected = collectSnapshots(app);
    const port = await freePort();
    await app.listen(port);

    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("reports a message as a ws request named after its gateway and pattern", async () => {
    const reply = new Promise((resolve) =>
      client.once("message", (raw) => resolve(JSON.parse(String(raw)))),
    );
    send("join", "lobby");

    // The wrapped handler still answers the client.
    expect(await reply).toEqual({ event: "joined", data: "joined:lobby" });

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "ChatGateway:join",
    );
    expect(snapshot.protocol).toBe("ws");
    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.userId).toBe("u-1");
    expect(snapshot.tags).toEqual({ environment: "test" });
    expect(snapshot.traces[0]).toMatchObject({
      className: "ChatGateway",
      methodKey: "join",
    });
    expect(snapshot.traces[0].children?.[0]).toMatchObject({
      className: "RoomsService",
      methodKey: "join",
    });
  });

  it("reports a throwing handler as a failed operation", async () => {
    send("explode");

    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "ChatGateway:explode",
    );
    expect(snapshot.attributes?.statusCode).toBe(500);
  });

  it("skips messages the ignore hook rejects", async () => {
    send("ping");
    send("join", "after-ping");

    await waitForSnapshot(
      collected,
      (item) => item.operationId === "ChatGateway:join",
    );
    expect(collected.operationIds).not.toContain("ChatGateway:ping");
  });
});
