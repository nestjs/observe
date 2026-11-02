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
 * Where a store keeps the W3C trace context its operation arrived with - see
 * `readTraceContext`. Absent when none came in; outbound calls then derive
 * their `traceparent` from the trace id instead.
 *
 * Apart from `traceIdKey` because the two can disagree: an `x-request-id`
 * from a proxy names the Observe trace, while the `traceparent` beside it
 * names the OpenTelemetry trace the caller is in, and both are passed on.
 */
export const TRACE_CONTEXT_KEY = "#traceContext";

/**
 * The job option the enqueuing side stamps the active trace id into. Both
 * BullMQ and Bull persist unknown options verbatim, so it survives the trip
 * through Redis without touching the job's data.
 */
export const JOB_TRACE_OPTION_KEY = "observeTraceId";
