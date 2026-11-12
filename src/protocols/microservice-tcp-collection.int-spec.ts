import {
  BadRequestException,
  Controller,
  INestMicroservice,
  IntrinsicException,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientProxyFactory,
  EventPattern,
  MessagePattern,
  Payload,
  Transport,
} from "@nestjs/microservices";
import { connect } from "net";
import { firstValueFrom } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

/**
 * The shape a microservice actually reaches for: `IntrinsicException` on its
 * own, with no HTTP exception underneath. A message pattern has no status to
 * borrow, so the base class has to be the entire signal.
 */
class DeclinedException extends IntrinsicException {}

@Controller()
class OrdersMessageController {
  @MessagePattern({ cmd: "sum" })
  sum(@Payload() data: number[]): number {
    return (data ?? []).reduce((total, value) => total + value, 0);
  }

  @MessagePattern("orders.find")
  find(@Payload() id: string) {
    return { id };
  }

  @MessagePattern({ cmd: "explode" })
  explode(): never {
    throw new Error("deliberate");
  }

  @MessagePattern({ cmd: "reject" })
  reject(): never {
    throw new BadRequestException("rejected");
  }

  @MessagePattern({ cmd: "decline" })
  decline(): never {
    throw new DeclinedException("declined");
  }

  @EventPattern("orders.created")
  // The parameter is declared for the decorator's sake: its type requires a
  // handler that accepts the event payload, and a zero-argument method fails
  // to typecheck under `tsc` even though Nest calls it happily at runtime.
  created(_event: unknown) {
    // Events are fire-and-forget: no response is sent, which is precisely why
    // the suite checks one is still traced.
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersMessageController],
})
class TcpTestModule {}

/**
 * Microservice collection over the TCP transport.
 *
 * The RPC agent attaches through `ModulesContainer.getRpcTargetRegistry()` and
 * the server's processing-start/end hooks - a different mechanism entirely from
 * the HTTP adapter's, so it needs its own real server to prove it works.
 *
 * TCP is used because it is the transport with no broker to stand up. The
 * non-gRPC branch of the agent is shared by every message-based transport, so
 * what passes here is what would pass for Redis, NATS or MQTT.
 */
describe("ObserveModule: microservice (TCP) collection", () => {
  let app: INestMicroservice;
  let client: ClientProxy;
  let collected: CollectedSnapshots;
  let port: number;

  beforeAll(async () => {
    port = await freePort();

    app = await NestFactory.createMicroservice(TcpTestModule, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
      instrument: ObserveInstrument,
      logger: false,
    } as never);

    collected = collectSnapshots(app);
    await app.listen();

    client = ClientProxyFactory.create({
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port },
    });
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
    await app?.close();
  });

  beforeEach(() => collected.clear());

  it("collects a snapshot for a request-response message", async () => {
    const result = await firstValueFrom(
      client.send<number>({ cmd: "sum" }, [1, 2, 3]),
    );
    expect(result).toBe(6);

    const snapshot = await waitForSnapshot(collected, () => true);

    // Transport[Transport.TCP] - the agent records the transport's name, not
    // the numeric enum, so a change in Nest's enum ordering cannot silently
    // relabel every stored trace.
    expect(snapshot.protocol).toBe("TCP");
    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.duration).toBeGreaterThanOrEqual(0);
  });

  it("derives an operation id from the message pattern", async () => {
    await firstValueFrom(client.send<number>({ cmd: "sum" }, [1, 1]));

    const snapshot = await waitForSnapshot(collected, () => true);

    // Whatever the exact serialisation, the pattern has to be recoverable -
    // otherwise every message in a service aggregates into one operation.
    expect(snapshot.operationId).toBeDefined();
    expect(String(snapshot.operationId)).toContain("sum");
  });

  it("separates distinct patterns", async () => {
    await firstValueFrom(client.send({ cmd: "sum" }, [1]));
    await firstValueFrom(client.send("orders.find", "abc"));

    await waitForSnapshot(collected, () => collected.items.length >= 2);

    const ids = collected.items.map((item) => String(item.operationId));
    expect(ids.some((id) => id.includes("sum"))).toBe(true);
    expect(ids.some((id) => id.includes("orders.find"))).toBe(true);
  });

  it("names a message by the route it reached, however its sender spelt it", async () => {
    // Nest finds the handler by the parsed, normalised pattern, so one
    // handler answers to any number of spellings. Named by the text, each
    // was an operation of the sender's choosing - and a route an
    // `@Objective` on the handler was declared for, once an hour each.
    const spellings = [
      '{ "cmd" : "sum" }',
      '{"cmd":"refund","cmd":"sum"}',
      '{"cmd":"s\\u0075m"}',
    ];
    const socket = connect(port, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => socket.once("connect", resolve));
      spellings.forEach((pattern, id) => {
        const packet = JSON.stringify({ pattern, data: [id], id: `${id}` });
        socket.write(`${packet.length}#${packet}`);
      });
      await waitForSnapshot(collected, () => collected.items.length >= 3);
    } finally {
      socket.destroy();
    }

    expect(collected.items.map((item) => item.operationId)).toEqual([
      '{"cmd":"sum"}',
      '{"cmd":"sum"}',
      '{"cmd":"sum"}',
    ]);
  });

  it("collects a handler that throws", async () => {
    await expect(
      firstValueFrom(client.send({ cmd: "explode" }, {})),
    ).rejects.toBeDefined();

    // The trace has to close on the error path too, or a failing handler is
    // invisible - the opposite of what an APM is for.
    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.protocol).toBe("TCP");
    // RPC has no response to read a status code off, so an unmodelled throw is
    // reported as a 500 - that is how the backend tells it apart from a failure
    // the handler raised deliberately.
    expect(snapshot.attributes?.statusCode).toBe(500);
  });

  it("reports a deliberately raised failure as handled", async () => {
    await expect(
      firstValueFrom(client.send({ cmd: "reject" }, {})),
    ).rejects.toBeDefined();

    // A 4xx, so the backend's aggregates count it as a handled error rather
    // than against the service's error budget. Without any status code at all
    // it would be counted as neither, which is what made a failing pattern
    // report zero errors of both kinds.
    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(400);
  });

  it("reports a bare IntrinsicException as handled too", async () => {
    await expect(
      firstValueFrom(client.send({ cmd: "decline" }, {})),
    ).rejects.toBeDefined();

    // No `getStatus()` to read here - the base class alone has to land it in the
    // handled bucket, or a microservice that models its failures without HTTP
    // exceptions is indistinguishable from one that crashed.
    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(400);
  });

  it("collects an event, which sends no response", async () => {
    // Events return nothing, so the processing-end hook is the only thing that
    // can close the trace. If it were tied to a reply being written, this is
    // the case that would silently collect nothing.
    client.emit("orders.created", { id: 1 });

    const snapshot = await waitForSnapshot(collected, () => true);
    expect(String(snapshot.operationId)).toContain("orders.created");
  });

  it("collects one snapshot per message", async () => {
    await firstValueFrom(client.send({ cmd: "sum" }, [1]));
    await firstValueFrom(client.send({ cmd: "sum" }, [2]));

    await waitForSnapshot(collected, () => collected.items.length >= 2);
    expect(collected.items).toHaveLength(2);
  });
});
