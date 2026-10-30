import { randomUUID } from "crypto";
import { hostname } from "os";
import { readSdkVersion } from "../utils/sdk-version.util.js";
import type { OtlpExportOptions } from "./otlp-options.interface.js";

export type OtlpAttributeValue = string | number | boolean;

/** `otlp`, resolved against the environment once, when the agent starts. */
export interface OtlpExportSettings {
  /** The full traces URL the batches are posted to. */
  url: string;
  headers: Record<string, string>;
  protocol: "http/protobuf" | "http/json";
  compression: "gzip" | "none";
  timeoutMs: number;
  /** Attributes of the resource every exported span belongs to. */
  resource: Record<string, OtlpAttributeValue>;
}

export interface ResolvedOtlpSettings {
  /** Undefined when export is off. */
  settings: OtlpExportSettings | undefined;
  /** What was wrong with the configuration, to be said once at start-up. */
  warnings: string[];
}

const DEFAULT_ENDPOINT = "http://localhost:4318";
const TRACES_PATH = "/v1/traces";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Resolves `otlp` into what the exporter needs, with no settings when export
 * is off - not asked for, or pointed at something that is not a URL.
 *
 * The environment only fills in what the options leave out; it never turns
 * export on by itself. An application that also runs an OpenTelemetry SDK
 * has these variables set for that SDK, and exporting from here too would
 * send every trace twice.
 */
export function resolveOtlpSettings(
  otlp: boolean | OtlpExportOptions | undefined,
  service: { serviceId: string; serviceVersion?: string | false },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOtlpSettings {
  if (!otlp) {
    return { settings: undefined, warnings: [] };
  }
  const options: OtlpExportOptions = otlp === true ? {} : otlp;
  const warnings: string[] = [];

  const signalEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const baseEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = options.endpoint
    ? toTracesUrl(options.endpoint)
    : signalEndpoint ||
      // The spec's own rule: the signal-specific variable is the whole URL,
      // the generic one a base the signal's path is added to.
      toTracesUrl(baseEndpoint || DEFAULT_ENDPOINT);
  let normalizedUrl: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(parsed.protocol);
    }
    // Scheme and host lower-cased: the exporter picks its transport off
    // the scheme, and `HTTPS://` is still https.
    normalizedUrl = parsed.toString();
  } catch {
    warnings.push(
      `OTLP export is off: the endpoint ${JSON.stringify(url)} is not an http(s) URL.`,
    );
    return { settings: undefined, warnings };
  }

  const protocolSetting =
    options.protocol ??
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL?.trim() ??
    env.OTEL_EXPORTER_OTLP_PROTOCOL?.trim();
  let protocol: OtlpExportSettings["protocol"] = "http/protobuf";
  if (protocolSetting === "http/json") {
    protocol = "http/json";
  } else if (protocolSetting === "grpc") {
    warnings.push(
      `OTLP over gRPC is not supported, so traces go to ${url} as http/protobuf. ` +
        "If that is the receiver's gRPC port (4317 by convention), point the endpoint at its HTTP port (4318) instead.",
    );
  } else if (protocolSetting && protocolSetting !== "http/protobuf") {
    warnings.push(
      `Unknown OTLP protocol ${JSON.stringify(protocolSetting)}; exporting http/protobuf.`,
    );
  }

  const compressionSetting =
    options.compression ??
    env.OTEL_EXPORTER_OTLP_TRACES_COMPRESSION?.trim() ??
    env.OTEL_EXPORTER_OTLP_COMPRESSION?.trim();
  let compression: OtlpExportSettings["compression"] = "gzip";
  if (compressionSetting === "none") {
    compression = "none";
  } else if (compressionSetting && compressionSetting !== "gzip") {
    warnings.push(
      `Unknown OTLP compression ${JSON.stringify(compressionSetting)}; exporting gzip.`,
    );
  }

  const timeoutMs =
    positive(options.timeoutMillis) ??
    positive(Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT)) ??
    positive(Number(env.OTEL_EXPORTER_OTLP_TIMEOUT)) ??
    DEFAULT_TIMEOUT_MS;

  const headers = {
    ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseKeyValueList(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS),
    ...options.headers,
  };

  // Lowest precedence first: what the agent knows, then the environment's
  // resource attributes, its service name - which the spec puts above them
  // - and last what the application passed in code.
  const resource: Record<string, OtlpAttributeValue> = {
    "service.name": service.serviceId,
    "service.instance.id": randomUUID(),
    "host.name": hostname(),
    "process.pid": process.pid,
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.versions.node,
    "telemetry.sdk.name": "@nestjs/observe",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.version": readSdkVersion(),
  };
  if (typeof service.serviceVersion === "string" && service.serviceVersion) {
    resource["service.version"] = service.serviceVersion;
  }
  Object.assign(resource, parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES));
  const envServiceName = env.OTEL_SERVICE_NAME?.trim();
  if (envServiceName) {
    resource["service.name"] = envServiceName;
  }
  Object.assign(resource, options.resourceAttributes);
  if (options.serviceName) {
    resource["service.name"] = options.serviceName;
  }

  return {
    settings: {
      url: normalizedUrl,
      headers,
      protocol,
      compression,
      timeoutMs,
      resource,
    },
    warnings,
  };
}

/**
 * The traces URL for a base endpoint: `/v1/traces` appended, unless it is
 * already there - so the full URL a vendor's docs give works as well as the
 * base the environment variable takes.
 */
function toTracesUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.endsWith(TRACES_PATH) ? trimmed : `${trimmed}${TRACES_PATH}`;
}

/**
 * `key=value,key2=value2`, as `OTEL_EXPORTER_OTLP_HEADERS` and
 * `OTEL_RESOURCE_ATTRIBUTES` spell them, values percent-decoded. A member
 * without a key or an `=` is skipped rather than failing the whole list.
 */
export function parseKeyValueList(
  value: string | undefined,
): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const member of value?.split(",") ?? []) {
    const separator = member.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = member.slice(0, separator).trim();
    const raw = member.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    try {
      parsed[key] = decodeURIComponent(raw);
    } catch {
      parsed[key] = raw;
    }
  }
  return parsed;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
