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
 * OpenTelemetry interop runs only beside reporting to NestJS Observe: the
 * first batch the collector accepts turns it on, and from then on only a
 * refusal of the credentials or a stopped worker pauses it - an outage at
 * NestJS Observe does not. The agent says so when it turns on or off.
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

  it("pauses at once when the collector refuses the credentials, says why, and resumes with the next batch it accepts", () => {
    const { agent, buffer, log, warn } = boot();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(`${PAUSED_MESSAGE_PREFIX}${Date.now() + 1_000}`);
    agent.handleMessage(REFUSED);

    expect(buffer.isIngesting()).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "OpenTelemetry interop is paused: the collector refused this app's credentials. " +
        "It resumes with the next batch the collector accepts.",
    );

    agent.handleMessage(ACCEPTED);

    expect(buffer.isIngesting()).toBe(true);
    const onLines = log.mock.calls.filter(([line]) =>
      line.includes("OpenTelemetry interop is on"),
    );
    expect(onLines).toHaveLength(2);
  });

  it("never turns on for credentials the collector refuses from the start", () => {
    const { agent, buffer, interopLines } = boot();

    agent.handleMessage(REFUSED);
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(false);
    expect(interopLines()).toEqual([]);
  });

  it("never turns on while no batch gets in, however long that lasts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { agent, buffer, interopLines } = boot();

    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + HOUR_MS);
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(false);
    expect(interopLines()).toEqual([]);
  });

  it("stays on through an outage at the collector, however long, and says nothing", () => {
    // A collector that is down, slow or answering 5xx: the worker posts the
    // same line for each batch it could not get in.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { agent, buffer, interopLines } = boot();
    agent.handleMessage(ACCEPTED);

    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + 10 * 60 * 1000);
    agent.handleMessage(FAILED);
    vi.setSystemTime(1_000_000 + 24 * HOUR_MS);
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(true);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
    ]);
  });

  it("stays on through a rate-limit pause, however long", () => {
    const { agent, buffer, interopLines } = boot();
    agent.handleMessage(ACCEPTED);

    // A 429: the paused line first, then the failure, as the worker posts them.
    agent.handleMessage(`${PAUSED_MESSAGE_PREFIX}${Date.now() + HOUR_MS}`);
    agent.handleMessage(FAILED);

    expect(buffer.isIngesting()).toBe(true);
    expect(interopLines()).toEqual([
      expect.stringContaining("OpenTelemetry interop is on"),
    ]);
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
