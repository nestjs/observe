import type Tracer from "dd-trace";
import { createRequire } from "node:module";
import {
  DATADOG_TEST_ENV,
  DatadogAgent,
  datadogRuns,
  startDatadogAgent,
} from "./datadog-agent.js";

export interface DatadogTracerOptions {
  /**
   * Also register dd-trace's OpenTelemetry `TracerProvider`, as Datadog
   * documents for an application that uses the OpenTelemetry API - and
   * nothing else: `DD_TRACE_OTEL_ENABLED`, which that setup sets too, stays
   * unset, so a suite shows the registration alone is what the agent needs.
   */
  tracerProvider?: boolean;
}

export interface DatadogTracer {
  /** The Agent the tracer in this process sends its spans to. */
  agent: DatadogAgent;
  /**
   * `fetch` as it was before dd-trace wrapped it, for a suite's own calls:
   * through the wrapped one, each would start a trace and send it along.
   */
  untracedFetch: typeof fetch;
}

const require = createRequire(import.meta.url);

/**
 * dd-trace started in this process the way an application starts it - first
 * thing, before anything loads http, express or @nestjs/core - for a suite
 * that runs the agent beside it. Call it from `vi.hoisted`: dd-trace patches
 * only what loads after it starts. Starts nothing where dd-trace does not
 * run, so a suite skipped there can still import this - and leaves nothing
 * open that a skipped suite would never close.
 */
export async function startDatadogTracer(
  options: DatadogTracerOptions = {},
): Promise<DatadogTracer> {
  const untracedFetch = globalThis.fetch;
  if (!datadogRuns) {
    const agent: DatadogAgent = {
      url: "",
      spans: [],
      close: () => Promise.resolve(),
    };
    return { agent, untracedFetch };
  }

  const agent = await startDatadogAgent();
  Object.assign(process.env, DATADOG_TEST_ENV, {
    DD_SERVICE: "orders",
    DD_TRACE_AGENT_URL: agent.url,
  });
  const tracer = require("dd-trace") as typeof Tracer;
  tracer.init();
  // The Agent is in this process only in a test. Traced, its intake would
  // make a span of every flush, flushed in turn, for as long as it runs.
  tracer.use("http", { server: { blocklist: [/^\/v0\.4\/traces/] } });
  if (options.tracerProvider) {
    new tracer.TracerProvider().register();
  }

  // Under Vitest a suite's imports reach these packages through Node's ESM
  // loader, and dd-trace's hooks only see `require` - see
  // `opentelemetry-sdk.ts`, which does the same for the OpenTelemetry SDK.
  for (const name of [
    "http",
    "https",
    "express",
    "@nestjs/core",
    "@nestjs/platform-express",
  ]) {
    require(name);
  }
  return { agent, untracedFetch };
}
