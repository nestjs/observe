import "reflect-metadata";
import {
  DynamicModule,
  INestApplication,
  LogLevel,
  NestApplicationOptions,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createRequire } from "node:module";
import {
  monitorEventLoopDelay,
  performance,
  PerformanceObserver,
} from "node:perf_hooks";
import { BenchModule } from "./app.module.js";
import type { BenchConfig, ServerMessage, ServerStats } from "./protocol.js";

/**
 * One application under test, forked by the runner with its configuration in
 * the environment. Statistics travel back over the IPC channel: an HTTP
 * route for them would itself be traced when the agent is on.
 */

const config = process.env.BENCH_CONFIG as BenchConfig;
const adapter = process.env.BENCH_ADAPTER ?? "express";
const sinkUrl = process.env.BENCH_SINK_URL;

const SERVICE_ID = "00000000-0000-4000-8000-00000000be0c";
const LOG_LEVELS: LogLevel[] = ["error", "warn"];

/**
 * The event-loop monitor's timer period. Its histogram records the time
 * between ticks, so the period is taken off to leave the delay alone.
 */
const EVENT_LOOP_RESOLUTION_MS = 10;

interface HeapStatistics {
  used_heap_size: number;
  total_heap_size: number;
}

/** The agent's reporting thread, when it runs one. */
let agentWorker:
  | { getHeapStatistics?: () => Promise<HeapStatistics> }
  | undefined;

async function observeSetup(): Promise<{
  imports: DynamicModule[];
  instrument?: NestApplicationOptions["instrument"];
}> {
  if (config === "baseline") {
    // Not even imported: the package's side effects are part of what is
    // being measured.
    return { imports: [] };
  }
  const { createObserveModule } = await import("@nestjs/observe");
  const { ObserveModule, ObserveInstrument } = createObserveModule();
  const options =
    config === "disabled"
      ? { enabled: false, serviceId: SERVICE_ID }
      : {
          // Any non-placeholder pair: the sink accepts every batch.
          appKey: "bench-app-key",
          appSecret: "bench-app-secret",
          serviceId: SERVICE_ID,
          endpoint: sinkUrl,
        };
  return {
    imports: [ObserveModule.forRoot(options)],
    instrument: ObserveInstrument,
  };
}

async function bootstrap() {
  const { imports, instrument } = await observeSetup();
  const module = BenchModule.register(imports);
  const options: NestApplicationOptions = { instrument, logger: LOG_LEVELS };

  const app =
    adapter === "fastify"
      ? await NestFactory.create(
          module,
          new (await import("@nestjs/platform-fastify")).FastifyAdapter(),
          options,
        )
      : await NestFactory.create(module, options);
  // A fixed port, from `BENCH_PORT`, for profiling the app by hand.
  await app.listen(Number(process.env.BENCH_PORT ?? 0), "127.0.0.1");
  agentWorker = await findAgentWorker(app);

  const address = app.getHttpServer().address() as { port: number };
  send({
    type: "ready",
    port: address.port,
    // performance's origin is the start of the process, so this is the whole
    // boot: module loading, DI, instrumentation, the worker thread, listen.
    bootMs: performance.now(),
    memory: process.memoryUsage(),
    packages: loadedPackages(),
  });
}

/**
 * The worker thread the agent ships telemetry from, whose heap the process's
 * RSS includes but `process.memoryUsage()` does not break out. It is not
 * public API: it is reached through the class the package registers, loaded
 * from the very file the package loads it from.
 */
async function findAgentWorker(
  app: INestApplication,
): Promise<typeof agentWorker> {
  if (config !== "on") {
    return undefined;
  }
  const { ObserveAgentWorker } = (await import(
    new URL(
      "./node_modules/@nestjs/observe/dist/agent/observe-agent.worker.js",
      import.meta.url,
    ).href
  )) as { ObserveAgentWorker: new (...args: never[]) => unknown };
  const service = app.get(ObserveAgentWorker, { strict: false }) as {
    worker?: typeof agentWorker;
  };
  return service.worker;
}

/**
 * The CommonJS packages loaded so far - Nest, Express and whatever the agent
 * pulled in. The runner records it so that a run can show it measured an
 * application holding only what it should.
 */
function loadedPackages(): string[] {
  const names = new Set<string>();
  for (const path of Object.keys(createRequire(import.meta.url).cache)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path);
    if (match) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

const eventLoopDelay = monitorEventLoopDelay({
  resolution: EVENT_LOOP_RESOLUTION_MS,
});
const eventLoopDelayMs = (nanoseconds: number) =>
  Math.max(0, nanoseconds / 1e6 - EVENT_LOOP_RESOLUTION_MS);
eventLoopDelay.enable();

let gcCount = 0;
let gcMs = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount += 1;
    gcMs += entry.duration;
  }
}).observe({ entryTypes: ["gc"] });

// `process.threadCpuUsage` arrived in Node 22.19; before it, the main-thread
// figures read as NaN and every other one still holds.
const threadCpuUsage = (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage =>
  typeof process.threadCpuUsage === "function"
    ? process.threadCpuUsage(previous)
    : { user: Number.NaN, system: Number.NaN };

let mark:
  | {
      cpu: NodeJS.CpuUsage;
      threadCpu: NodeJS.CpuUsage;
      at: number;
      gcCount: number;
      gcMs: number;
    }
  | undefined;

process.on("message", (message: { type: string }) => {
  if (message.type === "mark") {
    eventLoopDelay.reset();
    mark = {
      cpu: process.cpuUsage(),
      threadCpu: threadCpuUsage(),
      at: performance.now(),
      gcCount,
      gcMs,
    };
    send({ type: "marked" });
    return;
  }
  if (message.type === "collect" && mark) {
    void collect(mark);
  }
});

async function collect(since: NonNullable<typeof mark>) {
  const cpu = process.cpuUsage(since.cpu);
  const threadCpu = threadCpuUsage(since.threadCpu);
  const wallMs = performance.now() - since.at;
  const stats: ServerStats = {
    wallMs,
    cpuUs: cpu.user + cpu.system,
    mainThreadCpuUs: threadCpu.user + threadCpu.system,
    eventLoopDelayMs: {
      p50: eventLoopDelayMs(eventLoopDelay.percentile(50)),
      p99: eventLoopDelayMs(eventLoopDelay.percentile(99)),
      max: eventLoopDelayMs(eventLoopDelay.max),
    },
    gc: { count: gcCount - since.gcCount, ms: gcMs - since.gcMs },
    memory: process.memoryUsage(),
  };
  const workerHeap = await agentWorker
    ?.getHeapStatistics?.()
    .catch(() => undefined);
  if (workerHeap) {
    stats.workerHeap = {
      used: workerHeap.used_heap_size,
      total: workerHeap.total_heap_size,
    };
  }
  send({ type: "collected", stats });
}

function send(message: ServerMessage) {
  process.send?.(message);
}

// Exits through the normal path on SIGTERM, so `--cpu-prof` gets written.
process.on("SIGTERM", () => process.exit(0));

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
