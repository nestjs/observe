import { createRequire } from "node:module";
import type { OtlpReceiver } from "./otlp-receiver.js";
import { startTracedService, TracedService } from "./traced-service.js";

export interface OpenTelemetryServiceOptions {
  /** Its `service.name`. */
  name: string;
  /** The backend it exports its spans to. */
  otlp: OtlpReceiver;
  /** Where it passes every request on to; left out, it answers them itself. */
  next?: string;
  /**
   * `OTEL_PROPAGATORS`. OpenTelemetry's default when left out: W3C Trace
   * Context and baggage.
   */
  propagators?: string;
}

export type OpenTelemetryService = TracedService;

const require = createRequire(import.meta.url);

/**
 * Starts `traced-service.cjs` instrumented with OpenTelemetry the zero-code
 * way, and resolves once it listens.
 *
 * Only the `http` and `undici` instrumentations run, which are all its
 * server and its `fetch` need. Only the `env` resource detector runs: it
 * names the service, and the default set also asks cloud metadata endpoints
 * where it runs, which nothing on a laptop answers.
 */
export function startOpenTelemetryService(
  options: OpenTelemetryServiceOptions,
): Promise<OpenTelemetryService> {
  return startTracedService({
    name: options.name,
    execArgv: [
      "--require",
      require.resolve("@opentelemetry/auto-instrumentations-node/register"),
    ],
    env: {
      OTEL_SERVICE_NAME: options.name,
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: options.otlp.tracesUrl,
      // Spans reach the receiver moments after they end, rather than every
      // five seconds.
      OTEL_BSP_SCHEDULE_DELAY: "50",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_LOGS_EXPORTER: "none",
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,undici",
      OTEL_NODE_RESOURCE_DETECTORS: "env",
      OTEL_PROPAGATORS: options.propagators ?? "tracecontext,baggage",
    },
    next: options.next,
  });
}
