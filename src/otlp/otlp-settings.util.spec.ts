import {
  parseKeyValueList,
  resolveOtlpSettings,
} from "./otlp-settings.util.js";

const service = { serviceId: "orders-api", serviceVersion: "1.4.0" };
const resolve = (
  otlp: Parameters<typeof resolveOtlpSettings>[0],
  env: NodeJS.ProcessEnv = {},
) => resolveOtlpSettings(otlp, service, env);

describe("resolveOtlpSettings", () => {
  it("is off unless asked for, whatever the environment says", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };

    expect(resolve(undefined, env)).toEqual({
      settings: undefined,
      warnings: [],
    });
    expect(resolve(false, env).settings).toBeUndefined();
  });

  it("exports to the OpenTelemetry defaults with nothing configured", () => {
    const { settings, warnings } = resolve(true);

    expect(warnings).toEqual([]);
    expect(settings).toEqual(
      expect.objectContaining({
        url: "http://localhost:4318/v1/traces",
        headers: {},
        protocol: "http/protobuf",
        compression: "gzip",
        timeoutMs: 10_000,
      }),
    );
  });

  it("appends the traces path to a base endpoint, and keeps a full one as it is", () => {
    expect(
      resolve({ endpoint: "https://otlp.example.com/" }).settings?.url,
    ).toBe("https://otlp.example.com/v1/traces");
    expect(
      resolve({ endpoint: "https://otlp.example.com/otlp" }).settings?.url,
    ).toBe("https://otlp.example.com/otlp/v1/traces");
    expect(
      resolve({ endpoint: "https://otlp.example.com/v1/traces" }).settings?.url,
    ).toBe("https://otlp.example.com/v1/traces");
  });

  it("reads the endpoint as the spec says: the traces variable whole, the generic one as a base", () => {
    expect(
      resolve(true, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      }).settings?.url,
    ).toBe("http://collector:4318/v1/traces");
    expect(
      resolve(true, {
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:9999/custom",
      }).settings?.url,
    ).toBe("http://traces:9999/custom");
    expect(
      resolve(
        { endpoint: "http://code:4318" },
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://env:4318/v1/traces" },
      ).settings?.url,
    ).toBe("http://code:4318/v1/traces");
  });

  it("reads the scheme and host case-insensitively, as a URL does, and keeps the path as given", () => {
    expect(
      resolve({ endpoint: "HTTPS://OTLP.Example.com/Base" }).settings?.url,
    ).toBe("https://otlp.example.com/Base/v1/traces");
  });

  it("turns itself off, and says why, for an endpoint that is not an http(s) URL", () => {
    for (const endpoint of ["collector:4318", "grpc://collector:4317", "::"]) {
      const { settings, warnings } = resolve({ endpoint });

      expect(settings).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("OTLP export is off");
    }
  });

  it("merges headers: generic variable, then the traces one, then code", () => {
    const { settings } = resolve(
      { headers: { "x-honeycomb-team": "from-code" } },
      {
        OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=generic,x-tenant=acme",
        OTEL_EXPORTER_OTLP_TRACES_HEADERS:
          "x-tenant=traces,authorization=Basic%20dXNlcjpwYXNz",
      },
    );

    expect(settings?.headers).toEqual({
      "x-honeycomb-team": "from-code",
      "x-tenant": "traces",
      authorization: "Basic dXNlcjpwYXNz",
    });
  });

  it("takes protocol, compression and timeout from code, then the traces variable, then the generic one", () => {
    expect(
      resolve(true, {
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_COMPRESSION: "none",
        OTEL_EXPORTER_OTLP_TIMEOUT: "2500",
      }).settings,
    ).toEqual(
      expect.objectContaining({
        protocol: "http/json",
        compression: "none",
        timeoutMs: 2500,
      }),
    );
    expect(
      resolve(true, {
        OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
        OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      }).settings?.protocol,
    ).toBe("http/protobuf");
    expect(
      resolve(
        { protocol: "http/json", timeoutMillis: 700 },
        { OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf" },
      ).settings,
    ).toEqual(
      expect.objectContaining({ protocol: "http/json", timeoutMs: 700 }),
    );
  });

  it("warns that gRPC is not supported and exports http/protobuf instead", () => {
    const { settings, warnings } = resolve(true, {
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
    });

    expect(settings?.protocol).toBe("http/protobuf");
    expect(warnings).toEqual([
      expect.stringContaining("gRPC is not supported"),
    ]);
  });

  it("warns about an unknown protocol or compression and keeps the defaults", () => {
    const { settings, warnings } = resolve(true, {
      OTEL_EXPORTER_OTLP_PROTOCOL: "thrift",
      OTEL_EXPORTER_OTLP_COMPRESSION: "zstd",
      OTEL_EXPORTER_OTLP_TIMEOUT: "soon",
    });

    expect(settings).toEqual(
      expect.objectContaining({
        protocol: "http/protobuf",
        compression: "gzip",
        timeoutMs: 10_000,
      }),
    );
    expect(warnings).toHaveLength(2);
  });

  it("describes the service, then lets the environment and the code override it", () => {
    const defaults = resolve(true).settings!.resource;
    expect(defaults).toEqual(
      expect.objectContaining({
        "service.name": "orders-api",
        "service.version": "1.4.0",
        "process.pid": process.pid,
        "process.runtime.name": "nodejs",
        "telemetry.sdk.name": "@nestjs/observe",
        "telemetry.sdk.language": "nodejs",
      }),
    );
    expect(defaults["service.instance.id"]).toMatch(/^[0-9a-f-]{36}$/);

    const env = {
      OTEL_RESOURCE_ATTRIBUTES:
        "service.name=from-attributes,deployment.environment.name=prod",
      OTEL_SERVICE_NAME: "from-service-name",
    };
    // OTEL_SERVICE_NAME outranks service.name in OTEL_RESOURCE_ATTRIBUTES.
    expect(resolve(true, env).settings!.resource).toEqual(
      expect.objectContaining({
        "service.name": "from-service-name",
        "deployment.environment.name": "prod",
      }),
    );
    expect(
      resolve(
        {
          serviceName: "from-code",
          resourceAttributes: { "deployment.environment.name": "staging" },
        },
        env,
      ).settings!.resource,
    ).toEqual(
      expect.objectContaining({
        "service.name": "from-code",
        "deployment.environment.name": "staging",
      }),
    );
  });

  it("reports no service.version when there is no release", () => {
    expect(
      resolveOtlpSettings(
        true,
        { serviceId: "orders-api", serviceVersion: false },
        {},
      ).settings!.resource,
    ).not.toHaveProperty("service.version");
  });
});

describe("parseKeyValueList", () => {
  it("reads key=value pairs, percent-decoded, skipping members that are not pairs", () => {
    expect(
      parseKeyValueList(" a = 1 ,b=x%2Cy,=nokey,novalue,c=d=e,bad=%E0%A4%A"),
    ).toEqual({ a: "1", b: "x,y", c: "d=e", bad: "%E0%A4%A" });
    expect(parseKeyValueList(undefined)).toEqual({});
  });
});
