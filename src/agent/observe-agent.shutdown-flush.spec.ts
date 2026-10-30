import { EventEmitter } from "node:events";
import {
  clearInterval as clearRealInterval,
  setInterval as setRealInterval,
} from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeMetricsEncoder } from "../encoders/runtime-metrics.encoder.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { PAUSED_MESSAGE_PREFIX } from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/** `MAX_LOGS_PER_TRANSACTION` in the shared buffer. */
const MAX_LOGS_PER_TRANSACTION = 250;

/** `MAX_PENDING_LOGS` in the shared buffer. */
const MAX_PENDING_LOGS = 2000;

/**
 * Stands in for the worker thread on the other side of the shared buffer.
 *
 * The real thread's contract with the main thread is entirely in shared
 * memory: it takes the lock, reads the batch at offset 8, sends it, zeroes the
 * length at offset 4 and lets go. This does the same on its own timer (when
 * `consuming`), recording each batch it took, and notes how many it had taken
 * when `terminate` was called - which is what "sent before shutdown" comes
 * down to. The timer is `node:timers`, not the global one, so fake timers in a
 * suite stop it no more than they would stop a real thread.
 */
class FakeWorkerThread extends EventEmitter {
  readonly batches: Array<{
    logs?: Array<{ text: string }>;
    runtime?: unknown;
  }> = [];
  batchesAtTerminate: number | undefined;
  consuming = true;
  private readonly lock: Int32Array;
  private readonly timer: NodeJS.Timeout;

  readonly terminate = vi.fn(async () => {
    this.batchesAtTerminate = this.batches.length;
    clearRealInterval(this.timer);
    this.emit("exit", 1);
    return 1;
  });

  constructor(private readonly sharedBuffer: SharedArrayBuffer) {
    super();
    this.lock = new Int32Array(sharedBuffer, 0, 1);
    this.timer = setRealInterval(() => this.consume(), 5);
  }

  /** Dies on its own, as a crashed thread would. */
  crash() {
    clearRealInterval(this.timer);
    this.emit("exit", 1);
  }

  /** Answered 429: says so, as the real worker does, and leaves the slot be. */
  pauseAfter429() {
    this.consuming = false;
    this.emit("message", `${PAUSED_MESSAGE_PREFIX}${Date.now() + 60_000}`);
  }

  stop() {
    clearRealInterval(this.timer);
  }

  private consume() {
    if (!this.consuming || Atomics.compareExchange(this.lock, 0, 0, 1) !== 0) {
      return;
    }
    try {
      const length = new DataView(this.sharedBuffer, 4, 4);
      const size = length.getUint32(0);
      if (size === 0) {
        return;
      }
      const bytes = new Uint8Array(this.sharedBuffer).slice(8, 8 + size);
      this.batches.push(JSON.parse(new TextDecoder().decode(bytes)));
      length.setUint32(0, 0);
    } finally {
      Atomics.store(this.lock, 0, 0);
    }
  }
}

const logLines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: Date.now(),
    text: `${prefix}-${index}`,
  }));

/**
 * Covers what `onApplicationShutdown` does with telemetry that is still
 * buffered: it used to terminate the worker without a flush, so up to one
 * flush interval of data - including the errors of the last requests a
 * process served - was lost on every deploy.
 */
describe("ObserveAgentWorker shutdown flush", () => {
  let fake: FakeWorkerThread | undefined;
  let metrics: NodeRuntimeMetricsService | undefined;

  const boot = (
    overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
    registry?: Pick<OperationTraceRegistry, "hasSnapshotsAwaitingCompletion">,
  ) => {
    const options = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      // Long enough that only the shutdown flush can deliver anything.
      flushInterval: 60_000,
      runtimeMetrics: false,
      forwardLogs: true,
      ...overrides,
    } as ObserveModuleOptionsWithDefaults;

    const buffer = new ObserveAgentSharedBuffer(options);
    metrics = new NodeRuntimeMetricsService(options);
    metrics.onModuleInit();

    const agent = new ObserveAgentWorker(
      buffer,
      options,
      metrics,
      registry as OperationTraceRegistry | undefined,
    );
    const internals = agent as unknown as {
      logger: { error: () => void; debug: () => void; log: () => void };
      worker: unknown;
      lastRuntimeSampleAt: number;
      watchWorker: (worker: unknown) => void;
    };
    const error = vi
      .spyOn(internals.logger, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(internals.logger, "debug").mockImplementation(() => undefined);
    vi.spyOn(internals.logger, "log").mockImplementation(() => undefined);

    const thread = new FakeWorkerThread(buffer.sharedBuffer);
    const initializeWorker = vi
      .spyOn(agent, "initializeWorker")
      .mockImplementation(() => {
        internals.worker = thread;
        // The real listeners, so a thread that exits mid-flush meets the same
        // restart logic it would in production.
        internals.watchWorker(thread);
      });
    agent.onModuleInit();
    fake = thread;

    return { agent, buffer, thread, error, initializeWorker, internals };
  };

  afterEach(async () => {
    fake?.stop();
    fake = undefined;
    await metrics?.onApplicationShutdown();
    metrics = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends what is buffered before terminating the worker", async () => {
    const { agent, buffer, thread } = boot();
    buffer.pushLogs(logLines(3, "last-words"));

    await agent.onApplicationShutdown();

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batchesAtTerminate).toBe(1);
    expect(thread.batches[0].logs?.map((log) => log.text)).toEqual([
      "last-words-0",
      "last-words-1",
      "last-words-2",
    ]);
  });

  it("waits for snapshots still queued behind a zero timer", async () => {
    const { agent, buffer, thread } = boot();
    // How a protocol records a finished request or job whose spans were still
    // open: from a `setTimeout(0)` scheduled when it ended - here, just before
    // shutdown.
    setTimeout(() => buffer.pushLogs(logLines(1, "just-finished")), 0);

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(1);
    expect(thread.batches[0].logs?.[0].text).toBe("just-finished-0");
  });

  it("waits for snapshots the registry is still completing", async () => {
    let completing = true;
    const { agent, buffer, thread } = boot(
      {},
      { hasSnapshotsAwaitingCompletion: () => completing },
    );
    // A trace whose spans were still open when it ended lands a second later.
    setTimeout(() => {
      buffer.pushLogs(logLines(1, "completed-late"));
      completing = false;
    }, 100);

    await agent.onApplicationShutdown();

    expect(thread.batches.flatMap((batch) => batch.logs ?? [])).toEqual([
      expect.objectContaining({ text: "completed-late-0" }),
    ]);
  });

  it("sends a full log backlog in two batches, not one per 250 lines", async () => {
    const { agent, buffer, thread } = boot();
    buffer.pushLogs(
      logLines(MAX_LOGS_PER_TRANSACTION + MAX_PENDING_LOGS, "burst"),
    );

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(2);
    expect(thread.batches[0].logs).toHaveLength(MAX_LOGS_PER_TRANSACTION);
    const sent = thread.batches.flatMap((batch) => batch.logs ?? []);
    expect(sent).toHaveLength(MAX_LOGS_PER_TRANSACTION + MAX_PENDING_LOGS);
  });

  it("keeps draining the backlog when a final batch fails to encode", async () => {
    const { agent, buffer, thread } = boot();
    buffer.pushLogs(logLines(MAX_LOGS_PER_TRANSACTION + 10, "burst"));
    vi.spyOn(buffer, "encodeAndWrite").mockImplementationOnce(() => {
      throw new Error("Payload too large for shared buffer");
    });

    await agent.onApplicationShutdown();

    // The first batch is lost; the ten lines held back are not.
    expect(thread.batches.flatMap((batch) => batch.logs ?? [])).toHaveLength(
      10,
    );
  });

  it("waits for the batch the worker is still sending instead of overwriting it", async () => {
    const { agent, buffer, thread } = boot();
    // A batch the last scheduled flush handed over, not yet taken.
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "in-flight"));
    agent.flush();
    buffer.pushLogs(logLines(1, "still-buffered"));

    const shutdown = agent.onApplicationShutdown();
    await sleep(50);
    thread.consuming = true;
    await shutdown;

    expect(
      thread.batches.map((batch) => batch.logs?.map((log) => log.text)),
    ).toEqual([["in-flight-0"], ["still-buffered-0"]]);
    expect(thread.batchesAtTerminate).toBe(2);
  });

  it("puts a last runtime sample in the first batch when none is pending", async () => {
    const { agent, buffer, thread, internals } = boot({
      runtimeMetrics: true,
    });
    internals.lastRuntimeSampleAt = Date.now() - 60_000;
    buffer.pushLogs(logLines(1, "before"));

    await agent.onApplicationShutdown();

    expect(thread.batchesAtTerminate).toBe(1);
    expect(thread.batches[0].runtime).toBeDefined();
  });

  it("sends a pending runtime sample before taking the last one", async () => {
    const { agent, buffer, thread, internals } = boot({
      runtimeMetrics: true,
    });
    internals.lastRuntimeSampleAt = Date.now() - 60_000;
    const pending = metrics!.collectNodeRuntimeMetrics();
    buffer.addNodeRuntimeMetrics(pending);

    await agent.onApplicationShutdown();

    // Taken first, the last sample would have replaced the pending one.
    expect(thread.batchesAtTerminate).toBe(2);
    expect(thread.batches[0].runtime).toEqual(
      JSON.parse(JSON.stringify(RuntimeMetricsEncoder.encode(pending))),
    );
    expect(thread.batches[1].runtime).toBeDefined();
  });

  it("takes no last runtime sample for a process that has only just started", async () => {
    const { agent, buffer, thread } = boot({ runtimeMetrics: true });
    buffer.pushLogs(logLines(1, "short-lived"));

    await agent.onApplicationShutdown();

    expect(thread.batches).toHaveLength(1);
    expect(thread.batches[0].runtime).toBeUndefined();
  });

  it("terminates anyway when the worker never finishes the send", async () => {
    const { agent, buffer, thread } = boot({ shutdownFlushTimeout: 200 });
    // A collector that never answers: the worker keeps the slot filled.
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "in-flight"));
    agent.flush();
    buffer.pushLogs(logLines(1, "never-written"));

    let finished = false;
    const shutdown = agent.onApplicationShutdown().then(() => {
      finished = true;
    });

    await sleep(100);
    expect(finished).toBe(false);
    await shutdown;

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    // The unread batch was left as it was, not replaced by the later one.
    thread.consuming = true;
    (thread as unknown as { consume: () => void }).consume();
    expect(thread.batches[0].logs?.[0].text).toBe("in-flight-0");
  });

  it("does not wait for a worker paused after a 429", async () => {
    const { agent, buffer, thread } = boot();
    thread.pauseAfter429();
    // The paused worker leaves this batch where the last scheduled flush put it.
    buffer.pushLogs(logLines(1, "parked"));
    agent.flush();
    buffer.pushLogs(logLines(1, "never-sent"));

    const started = process.uptime();
    await agent.onApplicationShutdown();

    expect((process.uptime() - started) * 1000).toBeLessThan(500);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batches).toEqual([]);
  });

  it("finishes under fake timers", async () => {
    vi.useFakeTimers();
    const { agent, buffer, thread } = boot();
    buffer.pushLogs(logLines(1, "faked"));

    // Hung forever when the wait ran on the global `setTimeout` and the
    // deadline on `Date.now()`, both of which fake timers replace.
    await agent.onApplicationShutdown();

    expect(thread.batches[0].logs?.[0].text).toBe("faked-0");
    expect(thread.terminate).toHaveBeenCalledTimes(1);
  });

  it("shuts down once when asked twice", async () => {
    const { agent, buffer, thread } = boot();
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "twice"));

    const first = agent.onApplicationShutdown();
    await sleep(20);
    const second = agent.onApplicationShutdown();
    thread.consuming = true;

    await expect(Promise.all([first, second])).resolves.toBeDefined();
    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batches).toHaveLength(1);
  });

  it("skips the final send when shutdownFlushTimeout is 0", async () => {
    const { agent, buffer, thread } = boot({ shutdownFlushTimeout: 0 });
    buffer.pushLogs(logLines(1, "test-suite"));

    await agent.onApplicationShutdown();

    expect(thread.batches).toEqual([]);
    expect(thread.terminate).toHaveBeenCalledTimes(1);
  });

  it("terminates and does not throw when writing the final batch fails", async () => {
    const { agent, buffer, thread, error } = boot();
    buffer.pushLogs(logLines(1, "doomed"));
    vi.spyOn(buffer, "encodeAndWrite").mockImplementation(() => {
      throw new Error("Payload too large for shared buffer");
    });

    await expect(agent.onApplicationShutdown()).resolves.toBeUndefined();

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    expect(thread.batches).toEqual([]);
    // Reported the way every scheduled flush reports it, once.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("stops waiting when the worker dies mid-flush, and does not restart it", async () => {
    const { agent, buffer, thread, initializeWorker } = boot();
    thread.consuming = false;
    buffer.pushLogs(logLines(1, "stranded"));

    const shutdown = agent.onApplicationShutdown();
    await sleep(50);
    thread.crash();
    await shutdown;

    expect(thread.terminate).toHaveBeenCalledTimes(1);
    // Once at start-up; a restart here would leave a thread nothing stops.
    expect(initializeWorker).toHaveBeenCalledTimes(1);
  });

  it("sends nothing with the scaffold credentials, where no worker is started", async () => {
    const { agent, buffer } = boot({
      appKey: "YOUR_APP_KEY",
      appSecret: "YOUR_APP_SECRET",
    });
    // `onModuleInit` skips `initializeWorker` on this path, so the fake never
    // becomes the agent's worker.
    buffer.pushLogs(logLines(1, "placeholder"));

    await agent.onApplicationShutdown();

    expect(fake?.terminate).not.toHaveBeenCalled();
    expect(fake?.batches).toEqual([]);
  });
});
