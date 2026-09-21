/*
 * Backward compatibility, run for real: the packed SDK beside the OLDEST Nest
 * major it claims to support, with none of the newer framework hooks it can
 * take advantage of.
 *
 * The SDK feature-tests anything newer than its floor - the microservice
 * client's dispatch hook, packet metadata on a context - and must be a no-op
 * where they are absent, never an error. The repository's own suites run on
 * the newest Nest, where those tests always pass; this is the one that runs
 * where they fail. CI installs the tarball next to @nestjs/*@11 and runs it
 * from there (see ci.yml), so it resolves everything from its working
 * directory, not from this repository.
 *
 * Exercises the three entry points most exposed to framework internals: an
 * HTTP request, an RPC call through a ClientProxy to a TCP server, and a
 * WebSocket gateway message - and, riding on the HTTP one, the two features
 * that read what the adapter hands its hooks: the capture of a failed
 * request, and the span and trace header of an outbound `fetch()`.
 */
// Everything is resolved from the directory this is RUN in, not from where
// it lives: beside this file sits the repository's own, newest, Nest.
const load = require("module").createRequire(
  require("path").join(process.cwd(), "noop.js"),
);
load("reflect-metadata");
const { Module, Controller, Get, Injectable, Inject } = load("@nestjs/common");
const { NestFactory } = load("@nestjs/core");
const { ClientsModule, Transport, MessagePattern } = load(
  "@nestjs/microservices",
);
const { WebSocketGateway, SubscribeMessage } = load("@nestjs/websockets");
const { WsAdapter } = load("@nestjs/platform-ws");
const WebSocket = load("ws");
const path = load("path");
const root = process.cwd();
const { createObserveModule } = load("@nestjs/observe");
const { ObserveAgentSharedBuffer } = load(
  path.join(
    root,
    "node_modules/@nestjs/observe/dist/agent/observe-agent.shared-buffer.js",
  ),
);

const { ObserveModule, ObserveInstrument } = createObserveModule();
const TCP_PORT = 4871;
let httpPort = 0;
const dec = (decorators, target, key) =>
  key
    ? Reflect.decorate(
        decorators,
        target,
        key,
        Object.getOwnPropertyDescriptor(target, key),
      )
    : Reflect.decorate(decorators, target);

class MathController {
  sum(data) {
    return data.reduce((a, b) => a + b, 0);
  }
}
dec([MessagePattern("sum")], MathController.prototype, "sum");
dec([Controller()], MathController);

class ApiController {
  constructor(client) {
    this.client = client;
  }
  async total() {
    const { firstValueFrom } = load("rxjs");
    return { total: await firstValueFrom(this.client.send("sum", [1, 2, 3])) };
  }
  boom() {
    throw new Error("deliberate");
  }
  async relay() {
    const res = await fetch(`http://127.0.0.1:${httpPort}/echo-id`);
    return res.json();
  }
  echoId(req) {
    return { id: req.headers["x-request-id"] || null };
  }
}
dec([Get("total")], ApiController.prototype, "total");
dec([Get("boom")], ApiController.prototype, "boom");
dec([Get("relay")], ApiController.prototype, "relay");
dec(
  [Get("echo-id"), (t, k) => load("@nestjs/common").Req()(t, k, 0)],
  ApiController.prototype,
  "echoId",
);
dec(
  [
    Controller(),
    Reflect.metadata("design:paramtypes", [Object]),
    (t) => Inject("MATH")(t, undefined, 0),
  ],
  ApiController,
);

class ChatGateway {
  hello() {
    return { event: "hi", data: "there" };
  }
}
dec([SubscribeMessage("hello")], ChatGateway.prototype, "hello");
dec([WebSocketGateway()], ChatGateway);

class AppModule {}
dec(
  [
    Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "k",
          appSecret: "s",
          serviceId: "nest11-smoke",
          endpoint: "http://127.0.0.1:9",
          flushInterval: 600000,
        }),
        ClientsModule.register([
          {
            name: "MATH",
            transport: Transport.TCP,
            options: { host: "127.0.0.1", port: TCP_PORT },
          },
        ]),
      ],
      controllers: [ApiController, MathController],
      providers: [ChatGateway],
    }),
  ],
  AppModule,
);

(async () => {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
    logger: ["error", "warn"],
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.connectMicroservice({
    transport: Transport.TCP,
    options: { host: "127.0.0.1", port: TCP_PORT },
  });
  await app.startAllMicroservices();
  await app.listen(0);
  const port = app.getHttpServer().address().port;
  httpPort = port;

  const buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
  const seen = [];
  const snapshots = [];
  const original = buffer.insertRequestSnapshot.bind(buffer);
  buffer.insertRequestSnapshot = (snapshot) => {
    seen.push(`${snapshot.protocol}:${snapshot.operationId}`);
    snapshots.push(snapshot);
    return original(snapshot);
  };

  const http = await fetch(`http://127.0.0.1:${port}/total`);
  console.log("http ->", http.status, JSON.stringify(await http.json()));

  const boom = await fetch(`http://127.0.0.1:${port}/boom`, {
    headers: { "user-agent": "nest11-smoke" },
  });
  console.log("boom ->", boom.status);

  const relay = await fetch(`http://127.0.0.1:${port}/relay`, {
    headers: { "x-request-id": "nest11-relay-trace" },
  });
  const relayed = await relay.json();
  console.log("relay ->", relay.status, JSON.stringify(relayed));

  const reply = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once("open", () => socket.send(JSON.stringify({ event: "hello" })));
    socket.once("message", (raw) => {
      resolve(String(raw));
      socket.close();
    });
    socket.once("error", reject);
  });
  console.log("ws   ->", reply);

  await new Promise((r) => setTimeout(r, 400));
  const recorded = seen.sort().join(" | ");
  console.log("snapshots:", recorded);
  console.log(
    "nest core:",
    load(path.join(root, "node_modules/@nestjs/core/package.json")).version,
  );
  await app.close();
  const expected =
    "TCP:sum | http:/boom | http:/echo-id | http:/relay | http:/total | ws:ChatGateway:hello";
  if (http.status !== 200 || recorded !== expected) {
    console.log("FAILED: expected snapshots", expected);
    process.exit(1);
  }

  const find = (operationId) =>
    snapshots.find((snapshot) => snapshot.operationId === operationId);
  const captured = find("/boom").request;
  if (
    boom.status !== 500 ||
    captured?.headers?.["user-agent"] !== "nest11-smoke"
  ) {
    console.log("FAILED: the failed request was not captured", captured);
    process.exit(1);
  }
  const spanNames = (nodes = []) =>
    nodes.flatMap((node) => [node.className, ...spanNames(node.children)]);
  if (
    relayed.id !== "nest11-relay-trace" ||
    find("/echo-id").traceId !== "nest11-relay-trace" ||
    !spanNames(find("/relay").traces).includes("http")
  ) {
    console.log(
      "FAILED: the outbound fetch() was not recorded or not propagated",
    );
    process.exit(1);
  }
  process.exit(0);
})().catch((error) => {
  console.log("FAILED:", error.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
});
