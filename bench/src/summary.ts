import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BenchConfig, Scenario } from "./protocol.js";
import type { BootResult, InstanceResult, RunMetadata } from "./run.js";

/**
 * Turns the per-run results into medians across repetitions, and those into
 * the difference each configuration makes against the baseline.
 *
 * Re-summarise an earlier run with `node bench/.build/summary.js <raw.json>`.
 */

const MB = 1024 * 1024;

/** Field reads `GET /quote` makes inside its traced method: two per cart line. */
const COMPUTE_FIELD_READS = 2_000;

type Metrics = Record<string, number>;

interface Aggregate {
  median: number;
  min: number;
  max: number;
  values: number[];
}

/** Configuration, then metric. */
type ByConfig = Record<string, Record<string, Aggregate>>;

type Row = [metric: string, label: string, format: (value: number) => string];

export interface SummaryData {
  metadata: RunMetadata;
  boot: ByConfig;
  scenarios: Record<string, ByConfig>;
  derived: Record<string, number>;
}

function bootMetricsOf(result: BootResult): Metrics {
  const metrics: Metrics = {
    bootMs: result.bootMs,
    rssMb: result.memory.rss / MB,
    heapUsedMb: result.memory.heapUsed / MB,
    packages: result.packages.length,
  };
  if (result.idle) {
    // CPU microseconds per wall millisecond: CPU milliseconds per second.
    metrics.idleCpuMsPerSec = result.idle.cpuUs / result.idle.wallMs;
    metrics.idleMainCpuMsPerSec =
      result.idle.mainThreadCpuUs / result.idle.wallMs;
  }
  return metrics;
}

function metricsOf(result: InstanceResult): Metrics {
  const metrics: Metrics = {};
  for (const { rate, load, server } of result.fixed) {
    const prefix = `r${rate}.`;
    const perRequest = (value: number) => value / load.completed;
    Object.assign(metrics, {
      [`${prefix}cpuUs`]: perRequest(server.cpuUs),
      [`${prefix}mainCpuUs`]: perRequest(server.mainThreadCpuUs),
      [`${prefix}coreShare`]: (perRequest(server.cpuUs) * rate) / 1e6,
      [`${prefix}p50Ms`]: load.latencyMs.p50,
      [`${prefix}p99Ms`]: load.latencyMs.p99,
      [`${prefix}p999Ms`]: load.latencyMs.p999,
      [`${prefix}maxMs`]: load.latencyMs.max,
      [`${prefix}eldP99Ms`]: server.eventLoopDelayMs.p99,
      [`${prefix}eldMaxMs`]: server.eventLoopDelayMs.max,
      [`${prefix}gcUs`]: perRequest(server.gc.ms * 1000),
      [`${prefix}rssMb`]: server.memory.rss / MB,
      [`${prefix}heapTotalMb`]: server.memory.heapTotal / MB,
      [`${prefix}heapUsedMb`]: server.memory.heapUsed / MB,
      [`${prefix}errors`]: load.errors,
    });
    if (server.workerHeap) {
      metrics[`${prefix}workerHeapMb`] = server.workerHeap.total / MB;
    }
  }
  const { sink } = result;
  if (sink.snapshots > 0) {
    Object.assign(metrics, {
      tracesShipped: sink.snapshots,
      callsPerTrace: sink.calls / sink.snapshots,
      wireSpansPerTrace: sink.wireSpans / sink.snapshots,
      gzipBytesPerTrace: sink.bytes / sink.snapshots,
    });
  }
  if (result.saturation) {
    const { load, server } = result.saturation;
    Object.assign(metrics, {
      "sat.rps": load.rps,
      "sat.p50Ms": load.latencyMs.p50,
      "sat.p99Ms": load.latencyMs.p99,
      "sat.cpuUs": server.cpuUs / load.requests,
      "sat.mainCpuUs": server.mainThreadCpuUs / load.requests,
      "sat.rssMb": server.memory.rss / MB,
      "sat.heapTotalMb": server.memory.heapTotal / MB,
      "sat.errors": load.errors,
    });
    if (server.workerHeap) {
      metrics["sat.workerHeapMb"] = server.workerHeap.total / MB;
    }
  }
  return metrics;
}

function aggregate(values: number[]): Aggregate {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1], values };
}

/** Medians of every metric, per configuration. */
function aggregateByConfig(
  samples: Array<{ config: BenchConfig; metrics: Metrics }>,
): ByConfig {
  const values: Record<string, Record<string, number[]>> = {};
  for (const { config, metrics } of samples) {
    const byMetric = (values[config] ??= {});
    for (const [name, value] of Object.entries(metrics)) {
      (byMetric[name] ??= []).push(value);
    }
  }
  return Object.fromEntries(
    Object.entries(values).map(([config, byMetric]) => [
      config,
      Object.fromEntries(
        Object.entries(byMetric).map(([name, list]) => [name, aggregate(list)]),
      ),
    ]),
  );
}

export function summarize(
  metadata: RunMetadata,
  results: InstanceResult[],
  boots: BootResult[] = [],
): { data: SummaryData; markdown: string } {
  const boot = aggregateByConfig(
    boots.map((result) => ({
      config: result.config,
      metrics: bootMetricsOf(result),
    })),
  );
  const scenarios: SummaryData["scenarios"] = {};
  for (const scenario of new Set(results.map((result) => result.scenario))) {
    scenarios[scenario] = aggregateByConfig(
      results
        .filter((result) => result.scenario === scenario)
        .map((result) => ({
          config: result.config,
          metrics: metricsOf(result),
        })),
    );
  }
  const derived = derive(scenarios);
  const data: SummaryData = { metadata, boot, scenarios, derived };
  return { data, markdown: render(data) };
}

function median(
  scenarios: SummaryData["scenarios"],
  scenario: Scenario,
  config: BenchConfig,
  metric: string,
): number | undefined {
  return scenarios[scenario]?.[config]?.[metric]?.median;
}

function delta(
  scenarios: SummaryData["scenarios"],
  scenario: Scenario,
  config: BenchConfig,
  metric: string,
): number | undefined {
  const value = median(scenarios, scenario, config, metric);
  const baseline = median(scenarios, scenario, "baseline", metric);
  return value === undefined || baseline === undefined
    ? undefined
    : value - baseline;
}

/**
 * The figures a reader can multiply by: what one more traced call costs, and
 * what one more field read inside a traced method costs. Both come out of
 * the difference between scenarios that differ in nothing else.
 */
function derive(scenarios: SummaryData["scenarios"]): Record<string, number> {
  const derived: Record<string, number> = {};
  const calls = (scenario: Scenario) =>
    median(scenarios, scenario, "on", "callsPerTrace");
  for (const config of ["on", "reference", "disabled"] as const) {
    for (const [metric, label] of [
      ["sat.cpuUs", "saturation"],
      ["sat.mainCpuUs", "saturationMain"],
    ] as const) {
      const chatty = delta(scenarios, "chatty", config, metric);
      const hello = delta(scenarios, "hello", config, metric);
      const compute = delta(scenarios, "compute", config, metric);
      const chattyCalls = calls("chatty");
      const helloCalls = calls("hello");
      const computeCalls = calls("compute");
      if (
        chatty === undefined ||
        hello === undefined ||
        chattyCalls === undefined ||
        helloCalls === undefined
      ) {
        continue;
      }
      const perCall = (chatty - hello) / (chattyCalls - helloCalls);
      derived[`${config}.${label}.usPerTracedCall`] = perCall;
      if (compute !== undefined && computeCalls !== undefined) {
        derived[`${config}.${label}.usPerFieldRead`] =
          (compute - hello - perCall * (computeCalls - helloCalls)) /
          COMPUTE_FIELD_READS;
      }
    }
  }
  return derived;
}

const BOOT_ROWS: Row[] = [
  ["bootMs", "Process start to listening (ms)", (v) => v.toFixed(0)],
  ["rssMb", "RSS when listening (MB)", (v) => v.toFixed(1)],
  ["heapUsedMb", "Heap used when listening (MB)", (v) => v.toFixed(1)],
  ["packages", "CommonJS packages loaded", (v) => v.toFixed(0)],
  ["idleCpuMsPerSec", "Idle CPU, all threads (ms/s)", (v) => v.toFixed(2)],
  ["idleMainCpuMsPerSec", "Idle CPU, main thread (ms/s)", (v) => v.toFixed(2)],
];

const SINK_ROWS: Row[] = [
  ["tracesShipped", "Traces that reached the sink", (v) => v.toFixed(0)],
  ["callsPerTrace", "Calls traced per request", (v) => v.toFixed(1)],
  ["wireSpansPerTrace", "Spans shipped per request", (v) => v.toFixed(1)],
  ["gzipBytesPerTrace", "Gzipped bytes per trace", (v) => v.toFixed(0)],
];

function rateRows(rate: number): Row[] {
  const p = `r${rate}.`;
  return [
    [
      `${p}cpuUs`,
      `CPU per request, all threads (µs) @${rate} rps`,
      (v) => v.toFixed(1),
    ],
    [
      `${p}mainCpuUs`,
      `CPU per request, main thread (µs) @${rate} rps`,
      (v) => v.toFixed(1),
    ],
    [
      `${p}coreShare`,
      `Share of one core @${rate} rps`,
      (v) => `${(v * 100).toFixed(1)}%`,
    ],
    [`${p}p50Ms`, `p50 latency (ms) @${rate} rps`, (v) => v.toFixed(3)],
    [`${p}p99Ms`, `p99 latency (ms) @${rate} rps`, (v) => v.toFixed(3)],
    [`${p}p999Ms`, `p99.9 latency (ms) @${rate} rps`, (v) => v.toFixed(3)],
    [`${p}maxMs`, `max latency (ms) @${rate} rps`, (v) => v.toFixed(2)],
    [
      `${p}eldP99Ms`,
      `p99 event-loop delay (ms) @${rate} rps`,
      (v) => v.toFixed(2),
    ],
    [
      `${p}eldMaxMs`,
      `Max event-loop delay (ms) @${rate} rps`,
      (v) => v.toFixed(2),
    ],
    [`${p}gcUs`, `GC pause per request (µs) @${rate} rps`, (v) => v.toFixed(2)],
    [`${p}rssMb`, `RSS after phase (MB) @${rate} rps`, (v) => v.toFixed(1)],
    [
      `${p}heapTotalMb`,
      `Main heap size after phase (MB) @${rate} rps`,
      (v) => v.toFixed(1),
    ],
    [
      `${p}heapUsedMb`,
      `Main heap used after phase (MB) @${rate} rps`,
      (v) => v.toFixed(1),
    ],
    [
      `${p}workerHeapMb`,
      `Agent worker heap size (MB) @${rate} rps`,
      (v) => v.toFixed(1),
    ],
    [`${p}errors`, `Errors @${rate} rps`, (v) => v.toFixed(0)],
  ];
}

const SATURATION_ROWS: Row[] = [
  ["sat.rps", "Saturation throughput (rps)", (v) => v.toFixed(0)],
  ["sat.p50Ms", "Saturation p50 latency (ms)", (v) => v.toFixed(2)],
  ["sat.p99Ms", "Saturation p99 latency (ms)", (v) => v.toFixed(2)],
  [
    "sat.cpuUs",
    "Saturation CPU per request, all threads (µs)",
    (v) => v.toFixed(1),
  ],
  [
    "sat.mainCpuUs",
    "Saturation CPU per request, main thread (µs)",
    (v) => v.toFixed(1),
  ],
  ["sat.rssMb", "RSS after saturation (MB)", (v) => v.toFixed(1)],
  [
    "sat.heapTotalMb",
    "Main heap size after saturation (MB)",
    (v) => v.toFixed(1),
  ],
  [
    "sat.workerHeapMb",
    "Agent worker heap size after saturation (MB)",
    (v) => v.toFixed(1),
  ],
  ["sat.errors", "Saturation errors", (v) => v.toFixed(0)],
];

/**
 * One table of medians per configuration, with the difference each makes
 * against the baseline. A difference whose range overlaps the baseline's is
 * marked `~`: with this few repetitions it is not told apart from noise.
 */
function table(
  byConfig: ByConfig,
  configs: BenchConfig[],
  rows: Row[],
): string[] {
  const present = configs.filter((config) => byConfig[config]);
  const compared = present.filter((config) => config !== "baseline");
  const lines = [
    `| Metric | ${present.join(" | ")} | ${compared.map((c) => `${c} Δ`).join(" | ")} |`,
    `| --- | ${present.map(() => "---").join(" | ")} | ${compared.map(() => "---").join(" | ")} |`,
  ];
  for (const [metric, label, format] of rows) {
    if (!present.some((config) => byConfig[config]?.[metric])) {
      continue;
    }
    const cells = present.map((config) => {
      const entry = byConfig[config]?.[metric];
      return entry
        ? `${format(entry.median)} (${format(entry.min)}–${format(entry.max)})`
        : "";
    });
    const deltas = compared.map((config) => {
      const entry = byConfig[config]?.[metric];
      const baseline = byConfig.baseline?.[metric];
      if (!entry || !baseline) {
        return "";
      }
      const difference = entry.median - baseline.median;
      const overlaps = entry.max >= baseline.min && entry.min <= baseline.max;
      const relative =
        baseline.median !== 0
          ? ` (${difference >= 0 ? "+" : ""}${((difference / baseline.median) * 100).toFixed(0)}%)`
          : "";
      return `${overlaps ? "~" : ""}${difference >= 0 ? "+" : ""}${format(difference)}${relative}`;
    });
    lines.push(`| ${label} | ${cells.join(" | ")} | ${deltas.join(" | ")} |`);
  }
  return lines;
}

function render(data: SummaryData): string {
  const { metadata, boot, scenarios, derived } = data;
  const o = metadata.options;
  const lines: string[] = [
    `# @nestjs/observe overhead`,
    "",
    `SDK ${metadata.sdkVersion} (${metadata.commit}${metadata.sdkDir ? `, built from ${metadata.sdkDir}` : ""}${metadata.reference ? `; \`reference\` built from ${metadata.reference}` : ""}), Node ${metadata.node} on ${metadata.platform}, ${metadata.cpu} (${metadata.cores} cores, ${metadata.memoryGb} GB), ${metadata.adapter} adapter.`,
    `${o.reps} repetitions per configuration, interleaved; fixed-rate phases of ${o.durationSeconds}s at ${o.rates.join(" and ")} rps; saturation ${o.saturationSeconds}s with wrk, ${o.connections} connections; ${o.boots} boots per configuration, idle CPU over ${o.idleSeconds}s of each.`,
    `Load average ${metadata.loadAverageAtStart.map((v) => v.toFixed(2)).join(" ")} at start${metadata.loadAverageAtEnd ? `, ${metadata.loadAverageAtEnd.map((v) => v.toFixed(2)).join(" ")} at end` : ""}.`,
    "",
    "Cells are the median across repetitions, with the range in brackets. A difference whose ranges overlap the baseline's is marked `~`. Event-loop delay is the lateness of a 10 ms timer.",
    "",
  ];

  if (Object.keys(boot).length > 0) {
    lines.push("## Startup", "", ...table(boot, o.configs, BOOT_ROWS), "");
  }

  if (Object.keys(derived).length > 0) {
    lines.push("## Derived", "", "| Figure | Value |", "| --- | --- |");
    for (const [name, value] of Object.entries(derived)) {
      lines.push(`| ${name} | ${value.toFixed(3)} µs |`);
    }
    lines.push("");
  }

  const rows = [
    ...o.rates.flatMap(rateRows),
    ...(o.saturationSeconds > 0 ? SATURATION_ROWS : []),
    ...SINK_ROWS,
  ];
  for (const [scenario, byConfig] of Object.entries(scenarios)) {
    lines.push(`## ${scenario}`, "", ...table(byConfig, o.configs, rows), "");
  }
  return lines.join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const rawPath = process.argv[2];
  if (!rawPath) {
    console.error("Usage: node bench/.build/summary.js <raw.json>");
    process.exit(1);
  }
  const { metadata, boots, results } = JSON.parse(
    readFileSync(rawPath, "utf8"),
  ) as {
    metadata: RunMetadata;
    boots?: BootResult[];
    results: InstanceResult[];
  };
  const summary = summarize(metadata, results, boots);
  writeFileSync(
    join(dirname(rawPath), "summary.json"),
    JSON.stringify(summary.data, null, 2),
  );
  writeFileSync(join(dirname(rawPath), "summary.md"), summary.markdown);
  console.log(summary.markdown);
}
