import { spawn } from "node:child_process";
import { Agent, request } from "node:http";
import { performance } from "node:perf_hooks";

export interface LatencySummary {
  p50: number;
  p90: number;
  p99: number;
  p999: number;
  max: number;
  mean: number;
}

export interface FixedRateResult {
  rate: number;
  completed: number;
  errors: number;
  achievedRps: number;
  latencyMs: LatencySummary;
}

/**
 * Open-loop load: requests leave on a fixed schedule whether or not earlier
 * ones have been answered, so a server that stalls - a flush serialising a
 * batch on the main thread, say - is charged for every request that arrived
 * during the stall instead of quietly being sent fewer of them. Latency runs
 * from the moment each request was handed to the socket.
 */
export function runFixedRate(options: {
  port: number;
  path: string;
  headers: Record<string, string>;
  rate: number;
  durationMs: number;
}): Promise<FixedRateResult> {
  const { port, path, headers, rate, durationMs } = options;
  const agent = new Agent({ keepAlive: true, maxSockets: 256 });
  const total = Math.round((rate * durationMs) / 1000);
  const interval = 1000 / rate;
  const latencies = new Float64Array(total).fill(Number.NaN);
  let sent = 0;
  let settled = 0;
  let errors = 0;

  return new Promise((resolve) => {
    const start = performance.now() + 20;
    let lastSettledAt = start;

    const settle = () => {
      settled += 1;
      if (settled < total) {
        return;
      }
      lastSettledAt = performance.now();
      agent.destroy();
      const ok = Array.from(latencies).filter((value) => !Number.isNaN(value));
      resolve({
        rate,
        completed: ok.length,
        errors,
        achievedRps: (ok.length * 1000) / (lastSettledAt - start),
        latencyMs: summarize(ok),
      });
    };

    const fire = (index: number) => {
      const sentAt = performance.now();
      const req = request(
        { host: "127.0.0.1", port, path, agent, headers },
        (res) => {
          const failed = !res.statusCode || res.statusCode >= 300;
          res.resume();
          res.on("end", () => {
            if (failed) {
              errors += 1;
            } else {
              latencies[index] = performance.now() - sentAt;
            }
            settle();
          });
        },
      );
      req.on("error", () => {
        errors += 1;
        settle();
      });
      req.end();
    };

    const tick = () => {
      const now = performance.now();
      while (sent < total && start + sent * interval <= now) {
        fire(sent);
        sent += 1;
      }
      if (sent < total) {
        setTimeout(tick, Math.max(0, start + sent * interval - now));
      }
    };
    setTimeout(tick, 20);
  });
}

export interface SaturationResult {
  requests: number;
  rps: number;
  errors: number;
  latencyMs: { p50: number; p90: number; p99: number };
}

/**
 * Closed-loop load with wrk: as many requests as `connections` keep in
 * flight, for the most the application serves on one core.
 */
export function runSaturation(options: {
  port: number;
  path: string;
  headers: Record<string, string>;
  connections: number;
  durationSeconds: number;
}): Promise<SaturationResult> {
  const { port, path, headers, connections, durationSeconds } = options;
  const args = [
    "-t2",
    `-c${connections}`,
    `-d${durationSeconds}s`,
    "--latency",
    ...Object.entries(headers).flatMap(([name, value]) => [
      "-H",
      `${name}: ${value}`,
    ]),
    `http://127.0.0.1:${port}${path}`,
  ];
  return new Promise((resolve, reject) => {
    const wrk = spawn("wrk", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    wrk.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    wrk.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    wrk.on("error", reject);
    wrk.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`wrk exited with ${code}:\n${output}`));
        return;
      }
      try {
        resolve(parseWrk(output));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseWrk(output: string): SaturationResult {
  const number = (pattern: RegExp) => {
    const match = pattern.exec(output);
    return match ? Number(match[1]) : 0;
  };
  const latency = (percentile: string) => {
    const match = new RegExp(
      `^\\s+${percentile}%\\s+([\\d.]+)(us|ms|s)\\s*$`,
      "m",
    ).exec(output);
    if (!match) {
      throw new Error(`No ${percentile}% latency in wrk output:\n${output}`);
    }
    const scale = { us: 0.001, ms: 1, s: 1000 }[match[2] as "us" | "ms" | "s"];
    return Number(match[1]) * scale;
  };
  const socketErrors =
    /Socket errors: connect (\d+), read (\d+), write (\d+), timeout (\d+)/.exec(
      output,
    );
  return {
    requests: number(/(\d+) requests in/),
    rps: number(/Requests\/sec:\s+([\d.]+)/),
    errors:
      number(/Non-2xx or 3xx responses: (\d+)/) +
      (socketErrors
        ? socketErrors.slice(1).reduce((sum, value) => sum + Number(value), 0)
        : 0),
    latencyMs: { p50: latency("50"), p90: latency("90"), p99: latency("99") },
  };
}

function summarize(values: number[]): LatencySummary {
  if (values.length === 0) {
    return { p50: NaN, p90: NaN, p99: NaN, p999: NaN, max: NaN, mean: NaN };
  }
  const sorted = Float64Array.from(values).sort();
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))];
  return {
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    p999: at(0.999),
    max: sorted[sorted.length - 1],
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}
