/**
 * The request shapes the benchmark drives, all served by one application so
 * that every configuration instruments exactly the same providers.
 *
 * - `hello` - a controller returning a string. The floor: one span.
 * - `typical` - a guard, an interceptor, a pipe, a controller, a service and
 *   two repositories, each awaiting a turn of the event loop the way a driver
 *   round trip would. About eight spans and a 1 KB body - the headline row.
 * - `chatty` - a service formatting 100 rows through another provider, so
 *   102 spans, 100 of them collapsed before they are shipped. Prices a span.
 * - `compute` - one provider method pricing 1,000 cart lines, reading two of
 *   its own fields per line. Prices the proxy every field read inside a
 *   traced method goes through.
 */
export const SCENARIO_PATHS = {
  hello: "/hello",
  typical: "/orders/42",
  chatty: "/report",
  compute: "/quote",
} as const;

export type Scenario = keyof typeof SCENARIO_PATHS;

/** Sent by both load generators; the guard on `/orders` checks it. */
export const API_KEY_HEADER = "x-api-key";
export const API_KEY = "bench";

/** What runs in the application under test. */
export type BenchConfig =
  /** No `ObserveModule`, no `instrument`, the package never imported. */
  | "baseline"
  /** `ObserveModule.forRoot({ enabled: false })`, `instrument` passed. */
  | "disabled"
  /** Defaults, shipping every batch to the local sink. */
  | "on"
  /**
   * The same as `on`, with the package built from somewhere else - another
   * checkout - so a change is measured against what it replaces, in the same
   * run and under the same conditions.
   */
  | "reference";

export interface ServerStats {
  wallMs: number;
  /** Every thread of the process: the main one, the agent's worker, GC, libuv. */
  cpuUs: number;
  /** The thread requests are served on, alone. */
  mainThreadCpuUs: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  gc: { count: number; ms: number };
  memory: NodeJS.MemoryUsage;
  /** The agent's worker thread's own heap, in bytes, when it runs one. */
  workerHeap?: { used: number; total: number };
}

export type ServerMessage =
  | {
      type: "ready";
      port: number;
      bootMs: number;
      memory: NodeJS.MemoryUsage;
      /** CommonJS packages in the require cache, by name. */
      packages: string[];
    }
  | { type: "marked" }
  | { type: "collected"; stats: ServerStats };

export interface SinkStats {
  batches: number;
  /** Gzipped bytes received. */
  bytes: number;
  snapshots: number;
  /** Span nodes as they arrived, collapsed ones counted once. */
  wireSpans: number;
  /** Calls those nodes stand for, a collapsed node counting what it replaced. */
  calls: number;
  /** What the SDK's own wire contract found wrong with a batch, if anything. */
  violations: string[];
}

export type SinkMessage =
  | { type: "ready"; port: number }
  | { type: "stats"; stats: SinkStats };
