import { createRequire } from "node:module";
import { DATADOG_TEST_ENV, DatadogAgent } from "./datadog-agent.js";
import { startTracedService, TracedService } from "./traced-service.js";

export interface DatadogServiceOptions {
  /** Its `DD_SERVICE`. */
  name: string;
  /** The Agent it sends its spans to. */
  agent: DatadogAgent;
  /** Where it passes every request on to; left out, it answers them itself. */
  next?: string;
  /**
   * `DD_TRACE_PROPAGATION_STYLE`. dd-trace's default when left out: its own
   * `x-datadog-*` headers, W3C Trace Context and baggage, both ways.
   */
  propagationStyle?: string;
}

const require = createRequire(import.meta.url);

/**
 * Starts `traced-service.cjs` instrumented with dd-trace the zero-code way -
 * `--require dd-trace/init`, configured by `DD_*` variables alone - and
 * resolves once it listens.
 */
export function startDatadogService(
  options: DatadogServiceOptions,
): Promise<TracedService> {
  return startTracedService({
    name: options.name,
    execArgv: ["--require", require.resolve("dd-trace/init")],
    env: {
      ...DATADOG_TEST_ENV,
      DD_SERVICE: options.name,
      DD_TRACE_AGENT_URL: options.agent.url,
      ...(options.propagationStyle
        ? { DD_TRACE_PROPAGATION_STYLE: options.propagationStyle }
        : {}),
    },
    next: options.next,
  });
}
