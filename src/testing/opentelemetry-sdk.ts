import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createRequire } from "node:module";

/**
 * The OpenTelemetry Node SDK with its auto-instrumentations, started the way
 * an application starts it - `node --require ./tracing.js` - for a suite that
 * runs the agent beside it. Import this module before anything else: the
 * instrumentations only patch modules loaded after `start()`.
 *
 * Spans are kept in memory rather than exported, to be read back with
 * `getFinishedSpans()`.
 */
export const openTelemetrySpans = new InMemorySpanExporter();

const sdk = new NodeSDK({
  serviceName: "orders-api",
  spanProcessors: [new SimpleSpanProcessor(openTelemetrySpans)],
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();

// Under Vitest a suite's imports reach these packages through Node's ESM
// loader, and require-in-the-middle, which the instrumentations patch through,
// only sees `require`. Requiring them here, after `start()` and before anything
// else loads them, gives the suite what `--require` gives an application: the
// instrumentations patch the very modules the suite then imports, since the
// ESM loader reuses a CommonJS module that is already loaded.
const require = createRequire(import.meta.url);
for (const name of [
  "http",
  "https",
  "express",
  "fastify",
  "@nestjs/core",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "pg",
]) {
  require(name);
}

export function shutdownOpenTelemetry(): Promise<void> {
  return sdk.shutdown();
}
