import { AsyncResource } from "node:async_hooks";
import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { NodeAdapter } from "@nestjs/platform-node";
import request from "supertest";
import { createObserveModule } from "../observe.module.js";
import { TracerService } from "../services/tracer.service.js";
import {
  CollectedSnapshots,
  collectSnapshots,
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
// Set once the app is up: `setAttributes` is given at `forRoot`, before
// there is a tracer to hand it.
let tracerRef: TracerService | undefined;
// A callback a finished request leaves behind, still bound to its store.
let lateCallback: (() => void) | undefined;

const { ObserveModule, ObserveInstrument } = createObserveModule({
  sourceContext: false,
  attachTraceIdToLogs: false,
});

@Controller()
class OrdersController {
  constructor(private readonly tracer: TracerService) {}

  @Get("first")
  first() {
    return this.run("first");
  }

  @Get("second")
  second() {
    return this.run("second");
  }

  @Get("leaves-callback")
  leavesCallback() {
    lateCallback = AsyncResource.bind(() =>
      this.tracer.setOperationId("late-rename"),
    );
    return { id: "leaves-callback" };
  }

  private async run(id: string) {
    const execution = executions.get(id)!;
    (await this.tracer.activeSpan()).setTag("execution", id);
    execution.started = true;
    await execution.finish.promise;
    await this.tracer.createSpan(`manual.${id}`, () => undefined);
    return { id, traceId: this.tracer.currentTraceId() };
  }
}

@Module({
  imports: [
    ObserveModule.forRoot(
      testObserveOptions({
        outgoing: false,
        http: {
          // A callback that reaches for the tracer before the request's own
          // trace exists. It must land on nothing, not on another request.
          setAttributes: (req: { url?: string }) => {
            if (req.url === "/second") {
              tracerRef?.setOperationId("renamed-by-second");
            }
            return {};
          },
        },
      }),
    ),
  ],
  controllers: [OrdersController],
})
class TestModule {}

type Platform = "express" | "node" | "fastify";

/**
 * Two requests that share an adopted `x-request-id` must stay apart: both
 * open at once, and one long after the other. Sequential calls with distinct
 * ids cannot reveal a snapshot overwritten by another execution.
 */
describe.each<Platform>(["express", "node", "fastify"])(
  "ObserveModule: HTTP execution isolation (%s)",
  (platform) => {
    let app: INestApplication;
    let collected: CollectedSnapshots;

    const get = (path: string) =>
      request(app.getHttpServer())
        .get(path)
        .set("x-request-id", PUBLIC_TRACE_ID);

    beforeAll(async () => {
      app = await NestFactory.create(
        TestModule,
        platform === "fastify"
          ? new FastifyAdapter()
          : platform === "node"
            ? new NodeAdapter()
            : new ExpressAdapter(),
        { instrument: ObserveInstrument, logger: false },
      );
      collected = collectSnapshots(app);
      // `listen()` rather than `init()`: supertest closes a server it bound
      // itself once each request ends, and that close waits on every open
      // connection - including the other request still held at its gate.
      await app.listen(0, "127.0.0.1");
      tracerRef = app.get(TracerService);
    });

    afterAll(async () => {
      tracerRef = undefined;
      await app?.close();
    });

    beforeEach(() => {
      collected.clear();
      executions.clear();
      lateCallback = undefined;
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
        const replies = new Map<string, Promise<request.Response>>();
        try {
          for (const id of ["first", "second"]) {
            const reply = get(`/${id}`).then((response) => response);
            void reply.catch(() => undefined);
            replies.set(id, reply);
            await waitFor(
              () => executions.get(id)!.started,
              3000,
              `${id} handler to start`,
            );
          }

          executions.get(earlier)!.finish.release();
          const earlierReply = await replies.get(earlier)!;
          expect(earlierReply.body).toEqual({
            id: earlier,
            traceId: PUBLIC_TRACE_ID,
          });
          await waitForSnapshot(collected, () => true);

          executions.get(later)!.finish.release();
          const laterReply = await replies.get(later)!;
          expect(laterReply.body).toEqual({
            id: later,
            traceId: PUBLIC_TRACE_ID,
          });
          await waitFor(
            () => collected.items.length === 2,
            3000,
            "one snapshot per request",
          );

          for (const id of ["first", "second"]) {
            const snapshot = collected.find(`/${id}`);
            expect(snapshot?.traceId).toBe(PUBLIC_TRACE_ID);
            const tree = JSON.stringify(snapshot?.traces);
            expect(tree).toContain(`manual.${id}`);
            expect(tree).toContain(`"execution":"${id}"`);
            expect(tree).not.toContain(
              `manual.${id === "first" ? "second" : "first"}`,
            );
          }
          // The second request's `setAttributes` ran while the first was
          // open under the same id, and renamed neither.
          expect(collected.operationIds).not.toContain("renamed-by-second");
        } finally {
          // Release unfinished handlers even when an assertion fails, so
          // closing the app cannot leave a request waiting on our own gate.
          for (const execution of executions.values()) {
            execution.finish.release();
          }
          await Promise.allSettled(replies.values());
        }
      },
    );

    it("does not let a finished request rename a later one with the same id", async () => {
      await get("/leaves-callback").expect(200);
      await waitForSnapshot(
        collected,
        (item) => item.operationId === "/leaves-callback",
      );

      const reply = get("/first").then((response) => response);
      void reply.catch(() => undefined);
      try {
        await waitFor(
          () => executions.get("first")!.started,
          3000,
          "first handler to start",
        );
        lateCallback!();
      } finally {
        executions.get("first")!.finish.release();
      }
      expect((await reply).status).toBe(200);

      await waitFor(
        () => collected.items.length === 2,
        3000,
        "second snapshot",
      );
      expect(collected.operationIds).toEqual(["/leaves-callback", "/first"]);
    });
  },
);
