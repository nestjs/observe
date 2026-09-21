import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import { io, Socket } from "socket.io-client";
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

  // A plain return value, not an `{ event, data }` envelope: that is the shape
  // socket.io answers through the client's acknowledgement callback.
  @SubscribeMessage("count")
  count(@MessageBody() room: string) {
    return this.rooms.join(room).length;
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
 * The gateway suite again, on socket.io - the adapter most Nest gateways run.
 *
 * The patch sits above the platform adapter, so nothing in it names one. What
 * differs is delivery: socket.io hands the handler an acknowledgement callback
 * as a third argument and replies through it, and its long-polling transport
 * carries messages inside ordinary HTTP requests. The same assertions passing
 * here is what shows neither disturbs the trace.
 */
describe("ObserveModule: WebSocket gateway collection (socket.io)", () => {
  let app: NestExpressApplication;
  let collected: CollectedSnapshots;
  let client: Socket;

  const send = (event: string, data?: unknown) => client.emit(event, data);

  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(WsTestModule, {
      instrument: ObserveInstrument,
      logger: false,
    });
    app.useWebSocketAdapter(new IoAdapter(app));
    collected = collectSnapshots(app);
    const port = await freePort();
    await app.listen(port);

    client = io(`http://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      client.once("connect", () => resolve(undefined));
      client.once("connect_error", reject);
    });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("reports a message as a ws request named after its gateway and pattern", async () => {
    const reply = new Promise((resolve) => client.once("joined", resolve));
    send("join", "lobby");

    // The wrapped handler still answers the client.
    expect(await reply).toBe("joined:lobby");

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

  it("still delivers the reply through an acknowledgement callback", async () => {
    const acknowledged = await client.emitWithAck("count", "acked");

    expect(acknowledged).toBe("joined:acked".length);
    const snapshot = await waitForSnapshot(
      collected,
      (item) => item.operationId === "ChatGateway:count",
    );
    expect(snapshot.protocol).toBe("ws");
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
