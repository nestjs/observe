/**
 * Where, and how, `otlp` exports traces. Every field falls back to the
 * standard OpenTelemetry environment variable named beside it, then to the
 * OpenTelemetry default - so `otlp: true` alone exports wherever the
 * environment says, as any OpenTelemetry SDK would.
 */
export interface OtlpExportOptions {
  /**
   * The OTLP/HTTP receiver: a collector, an agent, or a vendor's endpoint.
   * Given as the base URL, the way `OTEL_EXPORTER_OTLP_ENDPOINT` takes it -
   * `/v1/traces` is appended unless the URL already ends with it.
   *
   * Falls back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (used as given), then
   * `OTEL_EXPORTER_OTLP_ENDPOINT`.
   * @default 'http://localhost:4318'
   */
  endpoint?: string;
  /**
   * Headers sent with every export - a vendor's API key, usually. Merged
   * over `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS`
   * (`key=value,key2=value2`), which keep any key this does not set.
   */
  headers?: Record<string, string>;
  /**
   * The OTLP/HTTP encoding. gRPC is not supported: point at the receiver's
   * HTTP port (4318 by convention) instead.
   *
   * Falls back to `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, then
   * `OTEL_EXPORTER_OTLP_PROTOCOL`.
   * @default 'http/protobuf'
   */
  protocol?: "http/protobuf" | "http/json";
  /**
   * Falls back to `OTEL_EXPORTER_OTLP_TRACES_COMPRESSION`, then
   * `OTEL_EXPORTER_OTLP_COMPRESSION`.
   * @default 'gzip'
   */
  compression?: "gzip" | "none";
  /**
   * Milliseconds one export may take before it is abandoned and retried.
   *
   * Falls back to `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT`, then
   * `OTEL_EXPORTER_OTLP_TIMEOUT`.
   * @default 10000
   */
  timeoutMillis?: number;
  /**
   * The `service.name` the spans are reported under.
   * Falls back to `OTEL_SERVICE_NAME`, then `serviceId`.
   */
  serviceName?: string;
  /**
   * Resource attributes on every span - `deployment.environment.name`,
   * `service.namespace` and the like. Merged over `OTEL_RESOURCE_ATTRIBUTES`
   * and the ones the agent sets itself (`service.version`, `host.name`,
   * `process.pid`, ...).
   */
  resourceAttributes?: Record<string, string | number | boolean>;
}
