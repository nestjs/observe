import * as Sentry from "@sentry/nestjs";
import { createRequire } from "node:module";

export interface SentryOptions {
  /** `tracesSampleRate`. Left out, Sentry records errors and no spans. */
  tracesSampleRate?: number;
  /** `propagateTraceparent`: send W3C `traceparent` too. Off by default. */
  propagateTraceparent?: boolean;
  /**
   * `enableOpenTelemetrySetup`: register Sentry's tracer, context manager
   * and propagator with the OpenTelemetry API. Off by default in Sentry 11,
   * which leaves the API to whatever else the application runs.
   */
  enableOpenTelemetrySetup?: boolean;
}

const require = createRequire(import.meta.url);

/**
 * Sentry's NestJS SDK started in this process the way its guide starts it -
 * `import "./instrument"` first thing in `main.ts` - for a suite that runs
 * the agent beside it. Call it from `vi.hoisted`: Sentry patches only what
 * loads after it starts.
 *
 * Nothing leaves the process: the DSN is never dialled, since the transport
 * drops what Sentry would send. Only calls to the inventory service's
 * `/stock/*` carry Sentry's headers, so a suite's own calls start no trace
 * downstream of it.
 */
export function startSentry(options: SentryOptions = {}): void {
  Sentry.init({
    dsn: "http://public@127.0.0.1:9/1",
    transport: () => ({
      send: () => Promise.resolve({}),
      flush: () => Promise.resolve(true),
    }),
    tracesSampleRate: options.tracesSampleRate,
    propagateTraceparent: options.propagateTraceparent,
    enableOpenTelemetrySetup: options.enableOpenTelemetrySetup,
    tracePropagationTargets: [/\/stock\//],
  });

  // Under Vitest a suite's imports reach these packages through Node's ESM
  // loader, and Sentry's hooks only see `require` - see
  // `opentelemetry-sdk.ts`, which does the same for the OpenTelemetry SDK.
  for (const name of [
    "http",
    "https",
    "express",
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/platform-express",
  ]) {
    require(name);
  }
}
