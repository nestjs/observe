import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import {
  DEGRADED_MESSAGE_PREFIX,
  NOT_INGESTED_MESSAGE_PREFIX,
  PAUSED_MESSAGE_PREFIX,
} from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

const ACCEPTED = `${DEGRADED_MESSAGE_PREFIX}false`;
const REFUSED = `${NOT_INGESTED_MESSAGE_PREFIX}refused`;
const FAILED = `${NOT_INGESTED_MESSAGE_PREFIX}failed`;
const HOUR_MS = 60 * 60 * 1000;

/**
 * OpenTelemetry interop runs only beside reporting to NestJS Observe: it is
 * on from start-up, once the agent's worker runs, and only a refusal of the
 * credentials or a stopped worker pauses it - an outage at NestJS Observe
 * does not. The agent says so when it turns on or off.
 *
 * Started through `onModuleInit`, with the worker thread itself left out,
 * and driven through `handleMessage`, as the worker's own lines arrive.
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

  /** Boots the agent and starts it as Nest does, its worker thread aside. */
  const start = (options: Partial<ObserveModuleOptionsWithDefaults> = {}) => {
    const started = boot(options);
    const initializeWorker = vi
      .spyOn(started.agent, "initializeWorker")
      .mockImplementation(() => undefined);
    started.agent.onModuleInit();
    return { ...started, initializeWorker };
  };

  afterEach(async () => {
    await booted?.onApplicationShutdown();
    booted = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is on from start-up, before any batch gets in, and says so once", () => {
    const { agent, buffer, interopLines } = start();

    expect(buffer.isReporting()).toBe(true);
    expect(buffer.isIngesting()).toBe(false);
    expect(interopLines()).toEqual([
      "OpenTelemetry interop is on: traceparent is read and sent beside reporting to NestJS Observe. " +
        "It stays on through collector outages and rate limits, and pauses only if the collector refuses the " +
        "app's credentials or the telemetry worker stops.",
    ]);

    agent.handleMessage(ACCEPTED);
    agent.handleMessage(ACCEPTED);

    expect(buffer.isReporting()).toBe(true);
    expect(interopLines()).toHaveLength(1);
  });

  it("pauses at once when the collector refuses the credentials, says why, and resumes with the next batch it accepts", () => {
    const { agent, buffer, log, warn } = start();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(`${PAUSED_MESSAGE_PREFIX}${Date.now() + 1_000}`);
    agent.handleMessage(REFUSED);

    expect(buffer.isReporting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "OpenTelemetry interop is paused: the collector refused this app's credentials. " +
        "It resumes with the next batch the collector accepts.",
    );

    agent.handleMessage(ACCEPTED);

    expect(buffer.isReporting()).toBe(true);
    expect(log).toHaveBeenLastCalledWith(
      "OpenTelemetry interop is on again: the collector accepted this app's telemetry, so traceparent is read " +
        "and sent.",
    );
  });

  it("pauses at the first refusal of credentials refused from the start, and stays paused", () => {
    const { agent, buffer, interopLines } = start();

    agent.handleMessage(REFUSED);
    agent.handleMessage(FAILED);
    agent.handleMessage(REFUSED);

    expect(buffer.isReporting()).toBe(false);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
      expect.stringContaining(
        "OpenTelemetry interop is paused: the collector refused this app's credentials",
      ),
    ]);
  });

  it("stays on from start-up while no batch gets in, however long that lasts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { agent, buffer, interopLines } = start();

    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + HOUR_MS);
    agent.handleMessage(FAILED);

    expect(buffer.isReporting()).toBe(true);
    expect(interopLines()).toHaveLength(1);
  });

  it("stays on through an outage at the collector, however long, and says nothing", () => {
    // A collector that is down, slow or answering 5xx: the worker posts the
    // same line for each batch it could not get in.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { agent, buffer, interopLines } = start();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + 10 * 60 * 1000);
    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + 24 * HOUR_MS);
    agent.handleMessage(FAILED);

    expect(buffer.isReporting()).toBe(true);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
    ]);
  });

  it("stays on through a rate-limit pause, however long", () => {
    const { agent, buffer, interopLines } = start();
    agent.handleMessage(ACCEPTED);

    // A 429: the paused line first, then the failure, as the worker posts them.
    agent.handleMessage(`${PAUSED_MESSAGE_PREFIX}${Date.now() + HOUR_MS}`);
    agent.handleMessage(FAILED);

    expect(buffer.isReporting()).toBe(true);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
    ]);
  });

  it("pauses when the worker stops, until a restarted one gets a batch in", () => {
    const { agent, buffer, warn, initializeWorker: restart } = start();
    restart.mockClear();
    const worker = new EventEmitter();
    (agent as unknown as { watchWorker: (worker: Worker) => void }).watchWorker(
      worker as unknown as Worker,
    );

    worker.emit("exit", 1);

    // Restarted, but not taken for reporting until it gets a batch in.
    expect(restart).toHaveBeenCalledTimes(1);
    expect(buffer.isReporting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the telemetry worker stopped"),
    );

    agent.handleMessage(ACCEPTED);

    expect(buffer.isReporting()).toBe(true);
  });

  it("says nothing about interop with openTelemetry off", () => {
    const { agent, interopLines } = start({ openTelemetry: undefined });

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
      const { agent, buffer, warn, interopLines } = boot(options);

      agent.onModuleInit();

      expect(buffer.isReporting()).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("OpenTelemetry interop stays off"),
      );
      expect(interopLines()).toHaveLength(1);
    },
  );
});
