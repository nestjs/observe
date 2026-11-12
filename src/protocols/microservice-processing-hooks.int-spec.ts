import {
  Controller,
  INestApplication,
  INestMicroservice,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxy,
  ClientProxyFactory,
  MessagePattern,
  Payload,
  Server,
  TcpContext,
  Transport,
} from "@nestjs/microservices";
import { firstValueFrom, timeout } from "rxjs";
import { createObserveModule } from "../observe.module.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { TracerService } from "../services/tracer.service.js";
import { nestMajor } from "../testing/nest-version.js";
import {
  CollectedSnapshots,
  collectSnapshots,
  freePort,
  testObserveOptions,
  waitFor,
  waitForSnapshot,
} from "../testing/observe-harness.js";

const { ObserveModule, ObserveInstrument } = createObserveModule();

/** What the application's hooks and handlers did, for the assertions below. */
const seen = {
  handled: [] as string[],
  audit: [] as string[],
  traceIds: [] as (string | null)[],
};

let tracer: TracerService | undefined;

@Controller()
class AccountsController {
  @MessagePattern("balance")
  balance(@Payload() account: string) {
    seen.handled.push(account);
    seen.traceIds.push(tracer?.currentTraceId() ?? null);
    return { account, balance: 1250 };
  }

  @MessagePattern("frozen.balance")
  frozenBalance(@Payload() account: string) {
    seen.handled.push(account);
    return { account, balance: 0 };
  }
}

@Module({
  imports: [ObserveModule.forRoot(testObserveOptions())],
  controllers: [AccountsController],
})
class AccountsModule {}

/**
 * The application's processing hooks, set on the server Nest hands it: a
 * message for a frozen account is never handled - its start hook does not
 * call `done` - and every handled one is audited from the end hook.
 */
function setProcessingHooks(server: Server): void {
  server.setOnProcessingStartHook((_transportId, ctx, done) => {
    if ((ctx as TcpContext).getPattern() === "frozen.balance") {
      return Promise.resolve();
    }
    return done();
  });
  server.setOnProcessingEndHook((_transportId, ctx) => {
    seen.audit.push((ctx as TcpContext).getPattern());
  });
}

const openTraces = (registry: OperationTraceRegistry) =>
  (registry as unknown as { traceSnapshots: Map<string, unknown> })
    .traceSnapshots.size;

/** The assertions every case below shares. */
function behavesAsBothHooksAsked(
  context: () => {
    client: ClientProxy;
    collected: CollectedSnapshots;
    registry: OperationTraceRegistry;
  },
) {
  beforeEach(() => {
    context().collected.clear();
    seen.handled.length = 0;
    seen.audit.length = 0;
    seen.traceIds.length = 0;
  });

  it("handles a message the application's hook lets through, and the agent records it", async () => {
    const { client, collected } = context();

    await expect(
      firstValueFrom(client.send("balance", "acc-1")),
    ).resolves.toEqual({ account: "acc-1", balance: 1250 });

    const snapshot = await waitForSnapshot(collected, (item) =>
      String(item.operationId).includes("balance"),
    );
    // Inside the agent's trace, inside the application's hook.
    expect(seen.traceIds).toEqual([snapshot.traceId]);
    await waitFor(() => seen.audit.length === 1, 2000, "the audit line");
    expect(seen.audit).toEqual(["balance"]);
  });

  it("does not handle a message the application's hook refuses, and leaves no trace open", async () => {
    const { client, registry } = context();
    const before = openTraces(registry);

    await expect(
      firstValueFrom(client.send("frozen.balance", "acc-2").pipe(timeout(500))),
    ).rejects.toThrow(/Timeout/);

    expect(seen.handled).toEqual([]);
    expect(seen.audit).toEqual([]);
    expect(openTraces(registry)).toBe(before);
  });
}

/**
 * A microservice server keeps one processing-start and one processing-end
 * hook, behind public setters, and the start hook decides whether a message
 * is handled at all - the application's to use as much as the agent's. The
 * agent used to set both from `onModuleInit`, in place of whatever the
 * application had set on the server since `createMicroservice()` returned;
 * one the application set later took the agent out instead.
 */
describe.runIf(nestMajor >= 12).each(["before listen()", "after listen()"])(
  "ObserveModule: processing hooks the application set on its server %s",
  (when) => {
    let app: INestMicroservice;
    let client: ClientProxy;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      const port = await freePort();
      app = await NestFactory.createMicroservice(AccountsModule, {
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
        instrument: ObserveInstrument,
        logger: false,
      } as never);
      collected = collectSnapshots(app);
      tracer = app.get(TracerService);
      const server = app.getTransportServer() as Server;
      if (when === "before listen()") {
        setProcessingHooks(server);
      }
      await app.listen();
      if (when === "after listen()") {
        setProcessingHooks(server);
      }

      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      await client.connect();
    });

    afterAll(async () => {
      tracer = undefined;
      await client?.close();
      await app?.close();
    });

    behavesAsBothHooksAsked(() => ({
      client,
      collected,
      registry: app.get(OperationTraceRegistry),
    }));
  },
);

/** The same, for a microservice connected to an HTTP application. */
describe.runIf(nestMajor >= 12)(
  "ObserveModule: processing hooks the application set on a connected microservice's server",
  () => {
    let app: INestApplication;
    let client: ClientProxy;
    let collected: CollectedSnapshots;

    beforeAll(async () => {
      const port = await freePort();
      app = await NestFactory.create(AccountsModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      const microservice = app.connectMicroservice({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      setProcessingHooks(microservice.getTransportServer() as Server);
      collected = collectSnapshots(app);
      tracer = app.get(TracerService);
      await app.startAllMicroservices();
      await app.init();

      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      await client.connect();
    });

    afterAll(async () => {
      tracer = undefined;
      await client?.close();
      await app?.close();
    });

    behavesAsBothHooksAsked(() => ({
      client,
      collected,
      registry: app.get(OperationTraceRegistry),
    }));
  },
);
