import { join } from "node:path";
import { Controller, INestMicroservice, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientProxyFactory,
  GrpcMethod,
  MessagePattern,
  Transport,
} from "@nestjs/microservices";
import { credentials, loadPackageDefinition } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { firstValueFrom } from "rxjs";
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

const PUBLIC_TRACE_ID = "shared-upstream-trace";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Execution {
  started: boolean;
  finish: ReturnType<typeof gate>;
}

const executions = new Map<string, Execution>();

@Controller()
class OrdersController {
  constructor(private readonly tracer: TracerService) {}

  @MessagePattern("orders.first")
  first(data: { id: string }) {
    return this.run(data);
  }

  @MessagePattern("orders.second")
  second(data: { id: string }) {
    return this.run(data);
  }

  @GrpcMethod("Orders", "FindOne")
  findOne(data: { id: string }) {
    return this.run(data);
  }

  @GrpcMethod("Orders", "Ping")
  ping(data: { id: string }) {
    return this.run(data);
  }

  private async run(data: { id: string }) {
    const execution = executions.get(data.id)!;
    this.tracer.setOperationId(`orders.${data.id}`);
    (await this.tracer.activeSpan()).setTag("execution", data.id);
    execution.started = true;
    await execution.finish.promise;
    await this.tracer.createSpan(`manual.${data.id}`, () => undefined);
    return { id: data.id, name: this.tracer.currentTraceId() };
  }
}

/**
 * Both handlers must be open before either finishes: sequential calls cannot
 * reveal a snapshot overwritten by a second operation with the same public id.
 * Each transport also needs its own proof, since gRPC starts from a timer.
 */
describe.each([
  ["TCP", Transport.TCP],
  ["gRPC", Transport.GRPC],
] as const)("ObserveModule: %s execution isolation", (_name, transport) => {
  let app: INestMicroservice;
  let collected: CollectedSnapshots;
  let invoke: (id: string) => Promise<{ id: string; name: string }>;
  let closeClient: () => void;

  beforeAll(async () => {
    const { ObserveModule, ObserveInstrument } = createObserveModule({
      traceIdGenerator: () => PUBLIC_TRACE_ID,
      sourceContext: false,
      attachTraceIdToLogs: false,
    });

    @Module({
      imports: [ObserveModule.forRoot(testObserveOptions({ outgoing: false }))],
      controllers: [OrdersController],
    })
    class TestModule {}

    const port = await freePort();
    const protoPath = join(
      import.meta.dirname,
      "..",
      "testing",
      "orders.test.proto",
    );
    app = await NestFactory.createMicroservice(TestModule, {
      transport,
      options:
        transport === Transport.TCP
          ? { host: "127.0.0.1", port }
          : { package: "orderstest", protoPath, url: `127.0.0.1:${port}` },
      instrument: ObserveInstrument,
      logger: false,
    } as never);
    collected = collectSnapshots(app);
    await app.listen();

    if (transport === Transport.TCP) {
      const client: ClientProxy = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      await client.connect();
      invoke = (id) => firstValueFrom(client.send(`orders.${id}`, { id }));
      closeClient = () => client.close();
    } else {
      const definition = loadSync(protoPath, { defaults: true });
      const proto = loadPackageDefinition(definition) as any;
      const client = new proto.orderstest.Orders(
        `127.0.0.1:${port}`,
        credentials.createInsecure(),
      );
      invoke = (id) =>
        new Promise((resolve, reject) => {
          client[id === "first" ? "FindOne" : "Ping"](
            { id },
            (error: unknown, response: { id: string; name: string }) =>
              error ? reject(error) : resolve(response),
          );
        });
      closeClient = () => client.close();
    }
  });

  afterAll(async () => {
    closeClient?.();
    await app?.close();
  });

  beforeEach(() => {
    collected.clear();
    executions.clear();
    for (const id of ["first", "second"]) {
      executions.set(id, { started: false, finish: gate() });
    }
  });

  it.each([
    ["first", "second"],
    ["second", "first"],
  ])(
    "keeps both snapshots when %s finishes before %s",
    async (earlier, later) => {
      const replies = new Map<string, Promise<{ id: string; name: string }>>();
      try {
        for (const id of ["first", "second"]) {
          const reply = invoke(id);
          void reply.catch(() => undefined);
          replies.set(id, reply);
          await waitFor(
            () => executions.get(id)!.started,
            3000,
            `${id} handler to start`,
          );
        }

        executions.get(earlier)!.finish.release();
        await expect(replies.get(earlier)).resolves.toEqual({
          id: earlier,
          name: PUBLIC_TRACE_ID,
        });
        await waitForSnapshot(collected, () => true);

        executions.get(later)!.finish.release();
        await expect(replies.get(later)).resolves.toEqual({
          id: later,
          name: PUBLIC_TRACE_ID,
        });
        await waitFor(
          () => collected.items.length === 2,
          3000,
          "one snapshot per RPC execution",
        );

        for (const id of ["first", "second"]) {
          const snapshot = collected.find(`orders.${id}`);
          expect(snapshot?.traceId).toBe(PUBLIC_TRACE_ID);
          const tree = JSON.stringify(snapshot?.traces);
          expect(tree).toContain(`manual.${id}`);
          expect(tree).toContain(`"execution":"${id}"`);
          expect(tree).not.toContain(
            `manual.${id === "first" ? "second" : "first"}`,
          );
        }
      } finally {
        // Release unfinished handlers even when an assertion fails, so closing
        // the test application cannot leave a client waiting on our own gate.
        for (const execution of executions.values()) {
          execution.finish.release();
        }
        await Promise.allSettled(replies.values());
      }
    },
  );
});
