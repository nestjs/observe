import {
  Controller,
  Get,
  INestApplication,
  Logger,
  Module,
  NotFoundException,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";
import {
  CapturedOutput,
  captureOutput,
  waitFor,
} from "../testing/observe-harness.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";

const PAUSED_NOTICE = "spike protection paused this account's overage";
const REDUCED_NOTICE = "has used its monthly allowance";
const UNPAUSED_NOTICE = "overage is no longer paused";

@Controller()
class CheckoutController {
  private readonly logger = new Logger(CheckoutController.name);

  @Get("ping")
  ping() {
    this.logger.log("ping served");
    return { ok: true };
  }

  @Get("missing")
  missing() {
    throw new NotFoundException();
  }

  @Get("checkout")
  checkout() {
    this.logger.error("payments unavailable");
    throw new Error("payments unavailable");
  }
}

/**
 * A paying account whose overage spike protection paused: the collector
 * accepts every batch, keeps only its server errors, and answers an agent
 * that lists `errors-only` with `{ degraded: true, errorsOnly: true,
 * reason: "spike" }` until someone resumes it.
 *
 * The real agent, from the collector's reply through the worker's line to the
 * main thread's notice and what it then stops sending. Logs are forwarded, so
 * there are records to withhold. The steps run in order against one app.
 */
describe("a paused overage, from the collector's reply to the operator's log", () => {
  let collector: FakeCollector;
  let output: CapturedOutput;
  let app: INestApplication;
  let buffer: ObserveAgentSharedBuffer;
  let baseUrl: string;
  let sent = 0;

  /** Sends a request under a trace id of its own, so its batch can be found. */
  const get = async (path: string, status = 200): Promise<string> => {
    const traceId = `paused-${++sent}`;
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { "x-request-id": traceId },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(status);
    return traceId;
  };

  const linesWith = (text: string) =>
    output.lines.filter((line) => line.includes(text));

  beforeAll(async () => {
    collector = await startFakeCollector();
    collector.answerWith({ degraded: true, errorsOnly: true, reason: "spike" });
    output = captureOutput();

    const { ObserveModule, ObserveInstrument } = createObserveModule();

    @Module({
      imports: [
        ObserveModule.forRoot({
          appKey: "test-key",
          appSecret: "test-secret",
          serviceId: "paused-app",
          endpoint: collector.url,
          flushInterval: 1000,
          runtimeMetrics: false,
          forwardLogs: true,
        }),
      ],
      controllers: [CheckoutController],
    })
    class PausedModule {}

    // With Nest's logger on: the notice is a log line, and `logger: false`
    // would silence the very thing under test.
    app = await NestFactory.create(PausedModule, {
      instrument: ObserveInstrument,
    });
    await app.listen(0);
    baseUrl = await app.getUrl();
    buffer = app.get(ObserveAgentSharedBuffer, { strict: false });
  });

  afterAll(async () => {
    await app?.close();
    output?.restore();
    await collector?.close();
  });

  it("says why only server errors are sent, once, and never that the allowance is spent", async () => {
    // Several batches, each answered errors-only, as a paused afternoon
    // sends. Server errors, so each one is sent whatever the agent has read.
    for (let i = 0; i < 3; i++) {
      await collector.waitForTrace(await get("/checkout", 500));
    }
    await waitFor(
      () => linesWith(PAUSED_NOTICE).length > 0,
      5_000,
      "the pause notice to be logged",
    );

    expect(linesWith(PAUSED_NOTICE)).toHaveLength(1);
    expect(linesWith(PAUSED_NOTICE)[0]).toContain("/dashboard/billing/usage");
    // What 0.3.12 logs for this reply, told `{ degraded: true }` alone.
    expect(linesWith(REDUCED_NOTICE)).toEqual([]);
    expect(linesWith(UNPAUSED_NOTICE)).toEqual([]);
  });

  it("sends the server errors alone, without their trees or a log record", async () => {
    await waitFor(
      () => buffer.isErrorsOnly(),
      5_000,
      "the agent to act on the paused answer",
    );

    const ping = await get("/ping");
    const missing = await get("/missing", 404);
    const checkout = await get("/checkout", 500);
    const batch = await collector.waitForTrace(checkout);

    const snapshot = batch.snapshots!.find((s) => s.ti === checkout);
    expect(snapshot!.a?.sc).toBe(500);
    expect(snapshot!.t).toEqual([]);
    // Recorded before the server error, so any batch that carried them has
    // arrived by now: batches leave one at a time, in order.
    expect(collector.batchCarrying(ping)).toBeUndefined();
    expect(collector.batchCarrying(missing)).toBeUndefined();
    // Both handlers logged, and Nest logged the failure: none of it is sent,
    // and all of it is counted with the trees.
    expect(batch).not.toHaveProperty("logs");
    expect(batch.truncatedSpans).toBeGreaterThan(0);
    expect(collector.violations).toEqual([]);
  });

  it("says everything is recorded again once the pause is resumed, and sends it", async () => {
    // What the collector answers once someone resumes full collection.
    collector.answerWith({ degraded: false });

    await collector.waitForTrace(await get("/checkout", 500));
    await waitFor(
      () => !buffer.isErrorsOnly() && !buffer.isDegraded(),
      5_000,
      "the agent to act on the undegraded answer",
    );
    await waitFor(
      () => linesWith(UNPAUSED_NOTICE).length > 0,
      5_000,
      "the resume notice to be logged",
    );

    const from = collector.batches.length;
    const ping = await get("/ping");
    const batch = await collector.waitForTrace(ping);
    const snapshot = batch.snapshots!.find((s) => s.ti === ping);
    expect(snapshot!.t!.length).toBeGreaterThan(0);
    // The handler's own line, among others, sent again.
    expect(
      collector.batches
        .slice(from)
        .some((received) => Array.isArray(received.logs)),
    ).toBe(true);

    expect(linesWith(UNPAUSED_NOTICE)).toHaveLength(1);
    expect(linesWith(PAUSED_NOTICE)).toHaveLength(1);
    expect(linesWith(REDUCED_NOTICE)).toEqual([]);
    expect(collector.violations).toEqual([]);
  });
});
