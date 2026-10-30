import { ChildProcess, execFileSync, fork } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareAppDir } from "./app-dir.js";
import {
  FixedRateResult,
  runFixedRate,
  runSaturation,
  SaturationResult,
} from "./load.js";
import {
  API_KEY,
  API_KEY_HEADER,
  BenchConfig,
  Scenario,
  SCENARIO_PATHS,
  ServerMessage,
  ServerStats,
  SinkMessage,
  SinkStats,
} from "./protocol.js";
import { summarize } from "./summary.js";

/**
 * Runs every scenario against every configuration, a fresh process per run,
 * and writes the raw results and a summary to `bench/results/<timestamp>`.
 *
 *   npm run bench
 *   npm run bench -- --scenarios hello,typical --reps 5
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

/** The JIT is warmed up at a rate the app sustains, rather than flat out. */
const WARMUP_RATE = 1_000;
/**
 * How long a freshly started app is left alone before its idle CPU is
 * measured, so that starting up - the agent's worker compiling its source
 * among it - is not counted as idling.
 */
const IDLE_SETTLE_MS = 2_000;

const { values } = parseArgs({
  options: {
    scenarios: { type: "string", default: "hello,typical,chatty,compute" },
    configs: { type: "string", default: "baseline,on" },
    reps: { type: "string", default: "2" },
    rates: { type: "string", default: "150" },
    duration: { type: "string", default: "10" },
    warmup: { type: "string", default: "5" },
    saturation: { type: "string", default: "10" },
    boots: { type: "string", default: "3" },
    // Seconds of idle CPU measured on each boot; 0 skips it.
    idle: { type: "string", default: "5" },
    connections: { type: "string", default: "64" },
    adapter: { type: "string", default: "express" },
    out: { type: "string" },
    "app-dir": {
      type: "string",
      default: join(tmpdir(), "nestjs-observe-bench-app"),
    },
    // A build of the package other than this checkout's `dist` - a patched
    // copy, to measure what a change would save before making it.
    "sdk-dir": { type: "string" },
    // A second build, run as the `reference` configuration next to `on`:
    // a directory holding its `package.json` and `dist`.
    reference: { type: "string" },
  },
});

const scenarios = values.scenarios.split(",") as Scenario[];
const configs = values.configs.split(",") as BenchConfig[];
if (values.reference && !configs.includes("reference")) {
  configs.push("reference");
}
const reps = Number(values.reps);
const rates = values.rates.split(",").map(Number);
const durationMs = Number(values.duration) * 1000;
const warmupSeconds = Number(values.warmup);
const saturationSeconds = Number(values.saturation);
const boots = Number(values.boots);
const idleSeconds = Number(values.idle);
const connections = Number(values.connections);
const adapter = values.adapter;
const headers = { [API_KEY_HEADER]: API_KEY };

for (const scenario of scenarios) {
  if (!(scenario in SCENARIO_PATHS)) {
    throw new Error(`Unknown scenario "${scenario}".`);
  }
}

export interface FixedRatePhase {
  rate: number;
  load: FixedRateResult;
  server: ServerStats;
}

/**
 * One start of the application: how long it took, what it held, and what it
 * costs idling before any traffic arrives.
 */
export interface BootResult {
  config: BenchConfig;
  bootMs: number;
  memory: NodeJS.MemoryUsage;
  packages: string[];
  idle?: ServerStats;
}

export interface InstanceResult {
  scenario: Scenario;
  config: BenchConfig;
  rep: number;
  bootMs: number;
  idleMemory: NodeJS.MemoryUsage;
  /** CommonJS packages loaded by the time the app listened. */
  packages: string[];
  fixed: FixedRatePhase[];
  saturation?: { load: SaturationResult; server: ServerStats };
  /** What reached the sink after the warm-up: proof the pipeline ran, and the shape of what it shipped. */
  sink: SinkStats;
  output: string;
}

export interface RunMetadata {
  startedAt: string;
  finishedAt?: string;
  sdkVersion: string;
  commit: string;
  node: string;
  platform: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  loadAverageAtStart: number[];
  loadAverageAtEnd?: number[];
  adapter: string;
  /** Set when the package was copied from somewhere other than `dist`. */
  sdkDir?: string;
  /** Where the `reference` configuration's build came from. */
  reference?: string;
  options: {
    scenarios: Scenario[];
    configs: BenchConfig[];
    reps: number;
    rates: number[];
    durationSeconds: number;
    warmupSeconds: number;
    saturationSeconds: number;
    connections: number;
    boots: number;
    idleSeconds: number;
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The commit measured, marked `-dirty` when tracked files have changes on top
 * of it - a run measures the working tree, not the commit it names.
 */
function currentCommit(): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot }).toString().trim();
  const commit = git("rev-parse", "--short", "HEAD");
  return git("status", "--porcelain", "--untracked-files=no")
    ? `${commit}-dirty`
    : commit;
}

/**
 * The configurations in a different order each round, so each takes every
 * position once and drift on the machine falls on all of them alike.
 */
const rotate = <T>(items: T[], round: number): T[] =>
  items.map((_, index) => items[(index + round) % items.length]);

function nextMessage<T extends { type: string }>(
  child: ChildProcess,
  type: T["type"],
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      cleanup();
      fail(new Error(`No "${type}" message within ${timeoutMs}ms.`));
    }, timeoutMs);
    const onMessage = (message: T) => {
      if (message.type === type) {
        cleanup();
        done(message);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      fail(new Error(`Process exited (${code}) before sending "${type}".`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // An OBSERVE_ENDPOINT or key pair in the caller's shell would send the
  // benchmark's telemetry somewhere real.
  for (const key of Object.keys(env)) {
    if (key.startsWith("OBSERVE_")) {
      delete env[key];
    }
  }
  return env;
}

async function startSink() {
  const child = fork(join(here, "sink.js"), [], {
    env: childEnv({}),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const { port } = await nextMessage<Extract<SinkMessage, { type: "ready" }>>(
    child,
    "ready",
  );
  return {
    url: `http://127.0.0.1:${port}`,
    /** Everything received since the last call, which starts a new count. */
    async take(): Promise<SinkStats> {
      const reply = nextMessage<Extract<SinkMessage, { type: "stats" }>>(
        child,
        "stats",
      );
      child.send({ type: "stats" });
      return (await reply).stats;
    },
    stop() {
      child.kill("SIGKILL");
    },
  };
}

/** The app each configuration runs from: `reference` has one of its own. */
type ServerPaths = Partial<Record<BenchConfig, string>> & { default: string };

async function startServer(
  serverPaths: ServerPaths,
  config: BenchConfig,
  sinkUrl: string,
) {
  const child = fork(serverPaths[config] ?? serverPaths.default, [], {
    env: childEnv({
      // The app itself knows only whether the agent is on.
      BENCH_CONFIG: config === "reference" ? "on" : config,
      BENCH_ADAPTER: adapter,
      BENCH_SINK_URL: sinkUrl,
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  const capture = (chunk: Buffer) => {
    if (output.length < 20_000) {
      output += chunk.toString();
    }
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const ready = await nextMessage<Extract<ServerMessage, { type: "ready" }>>(
    child,
    "ready",
  ).catch((error: Error) => {
    throw new Error(`${error.message}\n${output}`);
  });

  const ask = async <T extends ServerMessage>(
    type: string,
    reply: T["type"],
  ): Promise<T> => {
    const answer = nextMessage<T>(child, reply);
    child.send({ type });
    return answer;
  };

  return {
    port: ready.port,
    bootMs: ready.bootMs,
    idleMemory: ready.memory,
    packages: ready.packages,
    output: () => output,
    mark: () => ask("mark", "marked"),
    collect: async () =>
      (
        await ask<Extract<ServerMessage, { type: "collected" }>>(
          "collect",
          "collected",
        )
      ).stats,
    async stop() {
      const exited = new Promise((done) => child.once("exit", done));
      child.kill("SIGKILL");
      await exited;
    },
  };
}

async function runInstance(
  serverPaths: ServerPaths,
  scenario: Scenario,
  config: BenchConfig,
  rep: number,
  sink: Awaited<ReturnType<typeof startSink>>,
): Promise<InstanceResult> {
  const path = SCENARIO_PATHS[scenario];
  const server = await startServer(serverPaths, config, sink.url);
  try {
    // Warms the JIT up at a rate the app sustains rather than flat out: a
    // saturating burst leaves the heap sized for it, and every phase after it
    // would report that memory.
    await runFixedRate({
      port: server.port,
      path,
      headers,
      rate: WARMUP_RATE,
      durationMs: warmupSeconds * 1000,
    });
    await sink.take();

    const fixed: FixedRatePhase[] = [];
    for (const rate of rates) {
      await server.mark();
      const load = await runFixedRate({
        port: server.port,
        path,
        headers,
        rate,
        durationMs,
      });
      fixed.push({ rate, load, server: await server.collect() });
    }

    let saturation: InstanceResult["saturation"];
    if (saturationSeconds > 0) {
      await server.mark();
      const load = await runSaturation({
        port: server.port,
        path,
        headers,
        connections,
        durationSeconds: saturationSeconds,
      });
      saturation = { load, server: await server.collect() };
    }

    return {
      scenario,
      config,
      rep,
      bootMs: server.bootMs,
      idleMemory: server.idleMemory,
      packages: server.packages,
      fixed,
      saturation,
      sink: await sink.take(),
      output: server.output(),
    };
  } finally {
    await server.stop();
  }
}

function describeInstance(result: InstanceResult): string {
  const phases = result.fixed.map(
    ({ rate, load }) =>
      `${rate}rps: p50 ${load.latencyMs.p50.toFixed(3)}ms, p99 ${load.latencyMs.p99.toFixed(3)}ms`,
  );
  const saturation = result.saturation
    ? `; saturation ${result.saturation.load.rps.toFixed(0)}rps, ${(result.saturation.server.cpuUs / result.saturation.load.requests).toFixed(1)}us/req`
    : "";
  return `${phases.join("; ")}${saturation}; ${result.sink.snapshots} traces shipped`;
}

async function main() {
  const startedAt = new Date();
  const out = resolve(
    values.out ??
      join(
        repoRoot,
        "bench/results",
        startedAt.toISOString().replace(/[:.]/g, "-"),
      ),
  );
  mkdirSync(out, { recursive: true });
  const serverPaths: ServerPaths = {
    default: prepareAppDir(
      values["app-dir"],
      repoRoot,
      here,
      values["sdk-dir"] ? resolve(values["sdk-dir"]) : repoRoot,
    ),
  };
  if (values.reference) {
    serverPaths.reference = prepareAppDir(
      `${values["app-dir"]}-reference`,
      repoRoot,
      here,
      resolve(values.reference),
    );
  }

  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "package.json"), "utf8"),
  ) as { version: string };
  const metadata: RunMetadata = {
    startedAt: startedAt.toISOString(),
    sdkVersion: pkg.version,
    commit: currentCommit(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    loadAverageAtStart: loadavg(),
    adapter,
    sdkDir: values["sdk-dir"],
    reference: values.reference,
    options: {
      scenarios,
      configs,
      reps,
      rates,
      durationSeconds: durationMs / 1000,
      warmupSeconds,
      saturationSeconds,
      connections,
      boots,
      idleSeconds,
    },
  };

  const sink = await startSink();
  const bootResults: BootResult[] = [];
  const results: InstanceResult[] = [];
  const save = () =>
    writeFileSync(
      join(out, "raw.json"),
      JSON.stringify({ metadata, boots: bootResults, results }, null, 2),
    );

  try {
    for (let boot = 0; boot < boots; boot += 1) {
      for (const config of rotate(configs, boot)) {
        const server = await startServer(serverPaths, config, sink.url);
        let idle: ServerStats | undefined;
        if (idleSeconds > 0) {
          await sleep(IDLE_SETTLE_MS);
          await server.mark();
          await sleep(idleSeconds * 1000);
          idle = await server.collect();
        }
        bootResults.push({
          config,
          bootMs: server.bootMs,
          memory: server.idleMemory,
          packages: server.packages,
          idle,
        });
        await server.stop();
      }
    }
    save();
    console.log(
      `[${new Date().toISOString()}] ${bootResults.length} boots measured`,
    );

    for (const scenario of scenarios) {
      for (let rep = 0; rep < reps; rep += 1) {
        for (const config of rotate(configs, rep)) {
          const result = await runInstance(
            serverPaths,
            scenario,
            config,
            rep,
            sink,
          );
          results.push(result);
          save();
          console.log(
            `[${new Date().toISOString()}] ${scenario} ${config} #${rep + 1}: ${describeInstance(result)}`,
          );
        }
      }
    }
  } finally {
    sink.stop();
  }

  metadata.finishedAt = new Date().toISOString();
  metadata.loadAverageAtEnd = loadavg();
  save();

  const summary = summarize(metadata, results, bootResults);
  writeFileSync(
    join(out, "summary.json"),
    JSON.stringify(summary.data, null, 2),
  );
  writeFileSync(join(out, "summary.md"), summary.markdown);
  console.log(`\n${summary.markdown}\nResults in ${out}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
