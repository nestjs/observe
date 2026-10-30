export const OBSERVE_OPTIONS = "OBSERVE_OPTIONS";
export const CALLER_METADATA_KEY = "#caller";

/**
 * Where a store keeps the registry key when it differs from the trace id.
 *
 * Queued jobs and RPC calls can share the trace id of the operation that
 * dispatched them, including one still open in this process. The registry is
 * keyed per execution, so each gets a key of its own here while `traceIdKey`
 * keeps the id everything user-facing reads: logs, `currentTraceId()`, the
 * snapshot.
 */
export const TRACE_REGISTRY_KEY = "#registryKey";

/**
 * The job option the enqueuing side stamps the active trace id into. Both
 * BullMQ and Bull persist unknown options verbatim, so it survives the trip
 * through Redis without touching the job's data.
 */
export const JOB_TRACE_OPTION_KEY = "observeTraceId";
