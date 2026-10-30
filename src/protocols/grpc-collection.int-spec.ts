import { join } from "node:path";
import {
  BadRequestException,
  Controller,
  INestMicroservice,
  IntrinsicException,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GrpcMethod, Transport } from "@nestjs/microservices";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { createObserveModule } from "../observe.module.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

const PROTO_PATH = join(
  import.meta.dirname,
  "..",
  "testing",
  "orders.test.proto",
);

/**
 * The shape a microservice actually reaches for: `IntrinsicException` on its
 * own, with no HTTP exception underneath. gRPC has no status to borrow either,
 * so the base class has to be the entire signal.
 */
class DeclinedException extends IntrinsicException {}

@Controller()
class OrdersGrpcController {
  @GrpcMethod("Orders", "FindOne")
  findOne(data: { id: string }) {
    return { id: data.id, name: `order-${data.id}` };
  }

  @GrpcMethod("Orders", "Ping")
  ping(data: { id: string }) {
    return { id: data.id, name: "pong" };
  }

  @GrpcMethod("Orders", "Explode")
  explode(): never {
    throw new Error("deliberate");
  }

  @GrpcMethod("Orders", "Reject")
  reject(): never {
    throw new BadRequestException("rejected");
  }

  @GrpcMethod("Orders", "Decline")
  decline(): never {
    throw new DeclinedException("declined");
  }

  /**
   * The realistic shape of a failure: a handler that awaits something before it
   * throws. Kept separate from the synchronous cases because the two take
   * different paths through Nest's gRPC server.
   */
  @GrpcMethod("Orders", "ExplodeAsync")
  async explodeAsync(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error("deliberate");
  }

  @GrpcMethod("Orders", "RejectAsync")
  async rejectAsync(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new BadRequestException("rejected");
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [OrdersGrpcController],
})
class GrpcTestModule {}

/**
 * gRPC collection.
 *
 * Worth its own suite despite gRPC being a Nest microservice transport: the
 * agent branches on `Transport.GRPC` and runs `startGrpcRequestTracing`, which
 * is separate code from the message-based path the TCP suite covers. It reads
 * the operation id off the gRPC call rather than off a message pattern, and it
 * completes the trace on its own deferred path - so the TCP suite passing says
 * nothing about whether this works.
 */
describe("ObserveModule: gRPC collection", () => {
  let app: INestMicroservice;
  let collected: CollectedSnapshots;
  let client: any;

  beforeAll(async () => {
    const port = await freePort();
    const url = `127.0.0.1:${port}`;

    app = await NestFactory.createMicroservice(GrpcTestModule, {
      transport: Transport.GRPC,
      options: { package: "orderstest", protoPath: PROTO_PATH, url },
      instrument: ObserveInstrument,
      logger: false,
    } as never);

    collected = collectSnapshots(app);
    await app.listen();

    // A raw grpc-js client rather than Nest's ClientGrpc: this suite is about
    // the server side, and a plain client keeps the test free of a second
    // Nest app whose own instrumentation could confuse the assertions.
    const definition = loadSync(PROTO_PATH, {
      keepCase: true,
      defaults: true,
      oneofs: true,
    });
    const proto = loadPackageDefinition(definition) as any;
    client = new proto.orderstest.Orders(url, credentials.createInsecure());
  });

  afterAll(async () => {
    client?.close?.();
    await app?.close();
  });

  beforeEach(() => collected.clear());

  const call = (method: string, payload: Record<string, unknown>) =>
    new Promise<any>((resolve, reject) => {
      client[method](payload, (error: unknown, response: unknown) =>
        error ? reject(error) : resolve(response),
      );
    });

  it("collects a snapshot for a unary call", async () => {
    const response = await call("FindOne", { id: "42" });
    expect(response).toMatchObject({ id: "42", name: "order-42" });

    const snapshot = await waitForSnapshot(collected, () => true);

    expect(snapshot.protocol).toBe("GRPC");
    expect(snapshot.traceId).toEqual(expect.any(String));
    expect(snapshot.duration).toBeGreaterThanOrEqual(0);
  });

  it("names the operation after the gRPC method", async () => {
    await call("FindOne", { id: "7" });

    const snapshot = await waitForSnapshot(collected, () => true);

    // The gRPC branch reads `call.operationId` rather than deriving one from a
    // message pattern; if that ever returns undefined, every gRPC trace lands
    // in one unnamed bucket.
    expect(snapshot.operationId).toBeDefined();
    expect(String(snapshot.operationId)).toMatch(/FindOne/i);
  });

  it("separates distinct methods", async () => {
    await call("FindOne", { id: "1" });
    await call("Ping", { id: "1" });

    await waitForSnapshot(collected, () => collected.items.length >= 2);

    const ids = collected.items.map((item) => String(item.operationId));
    expect(ids.some((id) => /FindOne/i.test(id))).toBe(true);
    expect(ids.some((id) => /Ping/i.test(id))).toBe(true);
  });

  /**
   * This was a known gap until `ServerGrpc.createUnaryServiceMethod` started
   * firing `onProcessingEndHook` from the observable's `error` as well as its
   * `complete`. Before that, a handler that threw produced an observable that
   * never completed, so the end hook never ran, the trace never closed, and the
   * most valuable call on the gRPC path - the failing one - was invisible.
   *
   * Requires @nestjs/microservices >= 11.1.29.
   */
  it("collects a call whose handler throws", async () => {
    await expect(call("Explode", { id: "9" })).rejects.toBeDefined();

    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.protocol).toBe("GRPC");
    expect(String(snapshot.operationId)).toMatch(/Explode/i);
    // gRPC has no response to read a status code off, so an unmodelled throw is
    // reported as a 500 - that is how the backend tells it apart from a failure
    // the handler raised deliberately.
    expect(snapshot.attributes?.statusCode).toBe(500);
    expect(snapshot.error?.message).toBe("deliberate");
  });

  it("reports a deliberately raised failure as handled", async () => {
    await expect(call("Reject", { id: "9" })).rejects.toBeDefined();

    // A 4xx, so the backend's aggregates count it as a handled error rather
    // than against the service's error budget. Without any status code at all
    // it would be counted as neither.
    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(400);
  });

  it("reports a bare IntrinsicException as handled too", async () => {
    await expect(call("Decline", { id: "9" })).rejects.toBeDefined();

    // No `getStatus()` to read here - the base class alone has to land it in
    // the handled bucket, or a service that models its failures without HTTP
    // exceptions is indistinguishable from one that crashed.
    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(400);
  });

  it("collects an async handler that throws", async () => {
    await expect(call("ExplodeAsync", { id: "9" })).rejects.toBeDefined();

    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(500);
  });

  it("classifies an async deliberate failure as handled", async () => {
    await expect(call("RejectAsync", { id: "9" })).rejects.toBeDefined();

    const snapshot = await waitForSnapshot(collected, () => true);
    expect(snapshot.attributes?.statusCode).toBe(400);
  });

  it("collects one snapshot per call", async () => {
    await call("FindOne", { id: "1" });
    await call("FindOne", { id: "2" });
    await call("FindOne", { id: "3" });

    await waitForSnapshot(collected, () => collected.items.length >= 3);
    expect(collected.items).toHaveLength(3);
  });
});
