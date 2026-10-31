import {
  DEGRADED_MESSAGE_PREFIX,
  NOT_INGESTED_MESSAGE_PREFIX,
  PAUSED_MESSAGE_PREFIX,
} from "./degraded-ingest.protocol.js";
import { detachedObserveWorker } from "./detached-observe-worker.js";
import type {
  DetachedWorkerConfig,
  DetachedWorkerData,
} from "./detached-observe-worker.js";
import {
  createTelemetrySanitizer,
  SECTION_SHAPES,
} from "./telemetry-wire-contract.js";
import { describeIngestRefusal } from "../utils/ingest-refusal.util.js";
import { readSdkVersion } from "../utils/sdk-version.util.js";

/**
 * How the telemetry worker is put together, in one place.
 *
 * The worker runs as eval'd source with no module scope, so the code it needs
 * travels as stringified functions and the data it needs as `workerData`.
 * `ObserveAgentWorker.initializeWorker` and the worker's own tests both build
 * it from here on purpose: a test that assembled its own copy would keep
 * passing after the real assembly forgot something, which is exactly the
 * failure it exists to catch.
 */
export function detachedWorkerSource(): string {
  return `(${detachedObserveWorker.toString()})(${createTelemetrySanitizer.toString()}, ${describeIngestRefusal.toString()})`;
}

export function detachedWorkerData(input: {
  sharedBuffer: SharedArrayBuffer;
  endpoint: string;
  appKey?: string;
  appSecret?: string;
  flushInterval: number;
}): DetachedWorkerData {
  // Spelled out against the interface rather than spread, so a key the worker
  // starts reading is a compile error here until it is supplied.
  const config: DetachedWorkerConfig = {
    endpoint: input.endpoint,
    appKey: input.appKey,
    appSecret: input.appSecret,
    flushInterval: input.flushInterval,
    wireShapes: SECTION_SHAPES,
    degradedPrefix: DEGRADED_MESSAGE_PREFIX,
    pausedPrefix: PAUSED_MESSAGE_PREFIX,
    notIngestedPrefix: NOT_INGESTED_MESSAGE_PREFIX,
    sdkVersion: readSdkVersion(),
  };
  return { sharedBuffer: input.sharedBuffer, config };
}
