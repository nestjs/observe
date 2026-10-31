import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import {
  DEGRADED_MESSAGE_PREFIX,
  NOT_INGESTED_GRACE_MS,
  NOT_INGESTED_MESSAGE_PREFIX,
  PAUSED_MESSAGE_PREFIX,
} from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

const ACCEPTED = `${DEGRADED_MESSAGE_PREFIX}false`;
const REFUSED = `${NOT_INGESTED_MESSAGE_PREFIX}refused`;
const FAILED = `${NOT_INGESTED_MESSAGE_PREFIX}failed`;

/**
 * OpenTelemetry interop runs only while the agent is reporting to NestJS
 * Observe: the worker's lines about each batch open and close it, and the
 * agent says so when it turns on or off.
 *
 * Driven through `handleMessage`, as the worker's own lines arrive.
 */
describe("ObserveAgentWorker and OpenTelemetry interop", () => {
  // The agent each test booted, shut down after it.
  let booted: ObserveAgentWorker | undefined;

  const boot = (options: Partial<ObserveModuleOptionsWithDefaults> = {}) => {
    const resolved = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      runtimeMetrics: false,
      openTelemetry: true,
      ...options,
    } as ObserveModuleOptionsWithDefaults;
    const buffer = new ObserveAgentSharedBuffer(resolved);
    const agent = new ObserveAgentWorker(
      buffer,
      resolved,
      {} as NodeRuntimeMetricsService,
    );
    booted = agent;
    const { logger } = agent as unknown as {
      logger: {
        log: (m: string) => void;
        warn: (m: string) => void;
        error: (m: string) => void;
      };
    };
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const interopLines = () =>
      [...log.mock.calls, ...warn.mock.calls]
        .map(([line]) => line)
        .filter((line) => line.includes("OpenTelemetry interop"));
    return { agent, buffer, log, warn, interopLines };
  };

  afterEach(async () => {
    await booted?.onApplicationShutdown();
    booted = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("turns on with the first batch the collector accepts, and says so once", () => {
    const { agent, buffer, interopLines } = boot();
    expect(buffer.isIngesting()).toBe(false);

    agent.handleMessage(ACCEPTED);
    agent.handleMessage(ACCEPTED);

    expect(buffer.isIngesting()).toBe(true);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
    ]);
  });

  it("pauses at once when the collector refuses the credentials, and says why", () => {
    const { agent, buffer, warn } = boot();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(`${PAUSED_MESSAGE_PREFIX}${Date.now() + 1_000}`);
    agent.handleMessage(REFUSED);

    expect(buffer.isIngesting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "OpenTelemetry interop is paused: the collector refused this app's credentials",
      ),
    );
  });

  it("never turns on for credentials the collector refuses from the start", () => {
    const { agent, buffer, interopLines } = boot();

    agent.handleMessage(REFUSED);
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(false);
    expect(interopLines()).toEqual([]);
  });

  it("rides out a short outage, and pauses once batches have failed for the grace", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { agent, buffer, warn } = boot();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + NOT_INGESTED_GRACE_MS - 1);
    agent.handleMessage(FAILED);
    expect(buffer.isIngesting()).toBe(true);

    vi.setSystemTime(1_000_000 + NOT_INGESTED_GRACE_MS);
    agent.handleMessage(FAILED);
    expect(buffer.isIngesting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `no batch has reached the collector for ${NOT_INGESTED_GRACE_MS / 1000} seconds`,
      ),
    );

    agent.handleMessage(ACCEPTED);
    expect(buffer.isIngesting()).toBe(true);
  });

  it("pauses at once for a rate-limit pause longer than the grace", () => {
    const { agent, buffer } = boot();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(
      `${PAUSED_MESSAGE_PREFIX}${Date.now() + 5 * NOT_INGESTED_GRACE_MS}`,
    );
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(false);
  });

  it("pauses when the worker stops, until a restarted one gets a batch in", () => {
    const { agent, buffer, warn } = boot();
    const restart = vi
      .spyOn(agent, "initializeWorker")
      .mockImplementation(() => undefined);
    const worker = new EventEmitter();
    (agent as unknown as { watchWorker: (worker: Worker) => void }).watchWorker(
      worker as unknown as Worker,
    );
    agent.handleMessage(ACCEPTED);

    worker.emit("exit", 1);

    expect(restart).toHaveBeenCalled();
    expect(buffer.isIngesting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the telemetry worker stopped"),
    );
  });

  it("says nothing about interop with openTelemetry off", () => {
    const { agent, interopLines } = boot({ openTelemetry: undefined });

    agent.handleMessage(ACCEPTED);
    agent.handleMessage(REFUSED);

    expect(interopLines()).toEqual([]);
  });

  it.each([
    ["enabled: false", { enabled: false }],
    ["no credentials", { appKey: undefined, appSecret: undefined }],
    [
      "the nest new placeholders",
      { appKey: "YOUR_APP_KEY", appSecret: "YOUR_APP_SECRET" },
    ],
  ])(
    "warns at start-up that interop stays off with %s, since nothing is reported",
    (_, options) => {
      const { agent, warn } = boot(options);

      agent.onModuleInit();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("OpenTelemetry interop stays off"),
      );
    },
  );
});
