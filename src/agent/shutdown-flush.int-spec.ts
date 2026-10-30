import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createObserveModule } from "../observe.module.js";
import {
  FakeCollector,
  startFakeCollector,
} from "../testing/fake-collector.js";

/** `FINAL_FLUSH_TIMEOUT_MS` in the worker. */
const FINAL_FLUSH_TIMEOUT_MS = 2000;

@Controller()
class LastRequestController {
  @Get("last")
  last() {
    return { ok: true };
  }
}

let collector: FakeCollector;

/**
 * Boots an app whose flush timer cannot fire during the test, so whatever
 * reaches the collector got there through the shutdown flush.
 */
async function bootApp(): Promise<{
  app: INestApplication;
  get: (traceId: string) => Promise<void>;
}> {
  const { ObserveModule, ObserveInstrument } = createObserveModule();

  @Module({
    imports: [
      ObserveModule.forRoot({
        appKey: "test-key",
        appSecret: "test-secret",
        serviceId: "shutdown-app",
        endpoint: collector.url,
        flushInterval: 60_000,
        runtimeMetrics: false,
        forwardLogs: false,
      }),
    ],
    controllers: [LastRequestController],
  })
  class ShutdownModule {}

  const app = await NestFactory.create(ShutdownModule, {
    instrument: ObserveInstrument,
    logger: false,
  });
  await app.listen(0);
  const baseUrl = await app.getUrl();

  return {
    app,
    get: async (traceId) => {
      const response = await fetch(`${baseUrl}/last`, {
        headers: { "x-request-id": traceId },
      });
      await response.arrayBuffer();
      expect(response.status).toBe(200);
    },
  };
}

beforeEach(async () => {
  collector = await startFakeCollector();
});

afterEach(async () => {
  await collector.close();
});

it("delivers the requests served since the last flush when the app closes", async () => {
  const { app, get } = await bootApp();
  await get("served-before-close");
  // Nothing has been flushed yet: the timer is a minute away.
  expect(collector.batches).toEqual([]);

  // Closed straight after the response, while the HTTP agent may still be
  // completing the snapshot - the case a final flush that only looked at the
  // buffer as it stood would miss.
  await app.close();

  // Recorded on arrival, before the collector answers - so it is here once
  // `close()` resolves, or it was never sent.
  expect(collector.batchCarrying("served-before-close")).toBeDefined();
  expect(collector.violations).toEqual([]);
});

it("does not hold shutdown open for a collector that never answers", async () => {
  const { app, get } = await bootApp();
  await get("unanswered");
  const held = collector.holdAnswers();

  const started = Date.now();
  await app.close();
  const took = Date.now() - started;
  held.release();

  // The batch went out; the answer never came, and shutdown gave up on it.
  expect(collector.batchCarrying("unanswered")).toBeDefined();
  expect(took).toBeGreaterThanOrEqual(FINAL_FLUSH_TIMEOUT_MS - 100);
  expect(took).toBeLessThan(FINAL_FLUSH_TIMEOUT_MS + 2000);
});
