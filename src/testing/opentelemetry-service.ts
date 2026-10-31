import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { OtlpReceiver } from "./otlp-receiver.js";

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

export interface OpenTelemetryService {
  /** Where it listens, on 127.0.0.1. */
  readonly url: string;
  stop(): Promise<void>;
}

const require = createRequire(import.meta.url);

/**
 * Starts `opentelemetry-service.cjs` - a Node service instrumented with
 * OpenTelemetry the zero-code way - and resolves once it listens.
 *
 * It runs in a process of its own because the SDK instruments the whole
 * process it starts in: started in a suite's, it would instrument the Nest
 * service under test too, and the setup these services stand for has
 * OpenTelemetry in the services around that one, not in it.
 *
 * Only the `http` and `undici` instrumentations run, which are all its
 * server and its `fetch` need. Only the `env` resource detector runs: it
 * names the service, and the default set also asks cloud metadata endpoints
 * where it runs, which nothing on a laptop answers.
 */
export async function startOpenTelemetryService(
  options: OpenTelemetryServiceOptions,
): Promise<OpenTelemetryService> {
  const stderr: string[] = [];
  const child = fork(
    fileURLToPath(new URL("./opentelemetry-service.cjs", import.meta.url)),
    [],
    {
      execArgv: [
        "--require",
        require.resolve("@opentelemetry/auto-instrumentations-node/register"),
      ],
      // Nothing from this environment, so no OTEL_* variable a developer
      // has set changes what the service does.
      env: {
        PATH: process.env.PATH,
        OTEL_SERVICE_NAME: options.name,
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: options.otlp.tracesUrl,
        // Spans reach the receiver moments after they end, rather than
        // every five seconds.
        OTEL_BSP_SCHEDULE_DELAY: "50",
        OTEL_METRICS_EXPORTER: "none",
        OTEL_LOGS_EXPORTER: "none",
        OTEL_NODE_ENABLED_INSTRUMENTATIONS: "http,undici",
        OTEL_NODE_RESOURCE_DETECTORS: "env",
        OTEL_PROPAGATORS: options.propagators ?? "tracecontext,baggage",
        ...(options.next ? { NEXT_URL: options.next } : {}),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));

  const port = await new Promise<number>((resolve, reject) => {
    const settle = (error?: Error, listening?: number) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", settle);
      if (error) {
        child.kill("SIGKILL");
        reject(
          new Error(
            `The ${options.name} service did not start: ${error.message}\n${stderr.join("")}`,
          ),
        );
      } else {
        resolve(listening!);
      }
    };
    const onMessage = (message: { port?: number }) => {
      if (typeof message?.port === "number") {
        settle(undefined, message.port);
      }
    };
    const onExit = (code: number | null, signal: string | null) =>
      settle(new Error(`it exited (${code ?? signal}) before listening`));
    const timer = setTimeout(
      () => settle(new Error("it was not listening after 20 seconds")),
      20_000,
    );
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", settle);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      const exited = new Promise((resolve) => child.once("exit", resolve));
      // It exits when the channel closes. The SDK it runs keeps SIGTERM for
      // its own shutdown, which does not end the process.
      child.disconnect();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
