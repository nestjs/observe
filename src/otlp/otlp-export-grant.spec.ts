import { afterEach, describe, expect, it, vi } from "vitest";
import { DEGRADED_TTL_MS } from "../agent/degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "../agent/observe-agent.worker.js";
import type { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import type { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import {
  OTLP_EXPORT_MESSAGE_PREFIX,
  parseOtlpExportMessage,
} from "./otlp-export-grant.js";
import { OtlpTraceExporter } from "./otlp-trace-exporter.service.js";

const options = (
  overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
): ObserveModuleOptionsWithDefaults =>
  ({
    appKey: "k",
    appSecret: "s",
    serviceId: "orders-api",
    traceIdKey: "traceId",
    runtimeMetrics: false,
    openTelemetry: true,
    otlp: { endpoint: "http://127.0.0.1:4318" },
    ...overrides,
  }) as ObserveModuleOptionsWithDefaults;

/** A finished request: `children` spans under its handler, `status`, `ms`. */
const request = (
  overrides: Partial<RequestSnapshot> = {},
  children = 2,
): RequestSnapshot =>
  ({
    traceId: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
    calledAt: new Date().toISOString(),
    duration: 5,
    protocol: "http",
    operationId: "/orders",
    attributes: { method: "GET", statusCode: 200, originalUrl: "/orders" },
    traces: [
      {
        origin: "auto",
        className: "OrdersController",
        methodKey: "list",
        duration: 4,
        startOffset: 0,
        children: Array.from({ length: children }, () => ({
          origin: "auto",
          className: "OrdersService",
          methodKey: "load",
          duration: 1,
          startOffset: 1,
        })),
      },
    ],
    ...overrides,
  }) as RequestSnapshot;

const job = (overrides: Partial<JobSnapshot> = {}): JobSnapshot =>
  ({
    id: "1",
    traceId: "t",
    name: "send",
    queueName: "emails",
    duration: 5,
    traces: [
      {
        origin: "auto",
        className: "EmailsProcessor",
        methodKey: "process",
        duration: 4,
        startOffset: 0,
      },
    ],
    ...overrides,
  }) as JobSnapshot;

/** A stand-in exporter, set up to export, recording what it is handed. */
const exporter = () => ({
  enabled: true,
  url: "http://127.0.0.1:4318/v1/traces",
  exportRequestSnapshot: vi.fn(),
  exportJobSnapshot: vi.fn(),
});

const bufferWith = (
  otlp: ReturnType<typeof exporter>,
  overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
) =>
  new ObserveAgentSharedBuffer(
    options(overrides),
    undefined,
    otlp as unknown as OtlpTraceExporter,
  );

/** What the exporter was handed: each operation, and whether with its tree. */
const handedOver = (otlp: ReturnType<typeof exporter>) =>
  otlp.exportRequestSnapshot.mock.calls.map((call) => {
    const [snapshot, withTree] = call as [RequestSnapshot, boolean?];
    return `${snapshot.operationId}${withTree === false ? " (no tree)" : ""}`;
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parseOtlpExportMessage", () => {
  it("reads the grant the worker posts, and anything else as off", () => {
    expect(parseOtlpExportMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}full`)).toBe(
      "full",
    );
    expect(parseOtlpExportMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}capped`)).toBe(
      "capped",
    );
    expect(parseOtlpExportMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}off`)).toBe(
      "off",
    );
    // A value this agent does not know grants nothing.
    expect(parseOtlpExportMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}gold`)).toBe(
      "off",
    );
    expect(parseOtlpExportMessage("observe:degraded=false")).toBeNull();
  });
});

describe("ObserveAgentSharedBuffer: what it hands OTLP export", () => {
  it("hands over nothing until the collector has taken a batch and granted export", () => {
    const otlp = exporter();
    const buffer = bufferWith(otlp);

    // Granted, but nothing accepted yet: export runs beside reporting.
    buffer.setOtlpExport("full");
    buffer.insertRequestSnapshot(request());
    // Accepted, and the grant taken back by the reply.
    buffer.recordAccepted();
    buffer.setOtlpExport("off");
    buffer.insertRequestSnapshot(request());
    buffer.insertJobSnapshot(job());

    expect(otlp.exportRequestSnapshot).not.toHaveBeenCalled();
    expect(otlp.exportJobSnapshot).not.toHaveBeenCalled();
  });

  it("hands over nothing while the exporter is not set up to export", () => {
    const otlp = { ...exporter(), enabled: false };
    const buffer = bufferWith(otlp);
    buffer.recordAccepted();
    buffer.setOtlpExport("full");

    buffer.insertRequestSnapshot(request());

    expect(buffer.otlpExportGrant()).toBe("off");
    expect(otlp.exportRequestSnapshot).not.toHaveBeenCalled();
  });

  it("stops handing over when the collector refuses the credentials, and resumes with the next accepted batch", () => {
    const otlp = exporter();
    const buffer = bufferWith(otlp);
    buffer.recordAccepted();
    buffer.setOtlpExport("full");

    buffer.recordRefused();
    buffer.insertRequestSnapshot(request({ operationId: "/refused" }));
    buffer.recordAccepted();
    buffer.insertRequestSnapshot(request({ operationId: "/accepted" }));

    expect(handedOver(otlp)).toEqual(["/accepted"]);
  });

  describe("with a full grant", () => {
    it("hands over every request whole, whatever the collector said about the account", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      buffer.setOtlpExport("full");
      buffer.setIngestMode("errors-only");
      const snapshot = request({}, 3);

      buffer.insertRequestSnapshot(snapshot);

      expect(otlp.exportRequestSnapshot).toHaveBeenCalledWith(snapshot);
      expect(
        (snapshot.traces[0] as { children?: unknown[] }).children,
      ).toHaveLength(3);
    });

    it("hands over what Observe's own batch leaves out: past maxTracesPerBatch, or with no operation id", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp, { maxTracesPerBatch: 1 });
      buffer.recordAccepted();
      buffer.setOtlpExport("full");

      buffer.insertRequestSnapshot(request());
      buffer.insertRequestSnapshot(request());
      buffer.insertRequestSnapshot(
        request({ operationId: undefined, attributes: undefined }),
      );
      buffer.insertJobSnapshot(job({ id: "1" }));
      buffer.insertJobSnapshot(job({ id: "2" }));

      expect(otlp.exportRequestSnapshot).toHaveBeenCalledTimes(3);
      expect(otlp.exportJobSnapshot).toHaveBeenCalledTimes(2);
    });

    it("holds through a quiet collector, for as long as the agent is reporting", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      buffer.setOtlpExport("full");

      vi.setSystemTime(Date.now() + DEGRADED_TTL_MS * 10);
      buffer.insertRequestSnapshot(request());

      expect(otlp.exportRequestSnapshot).toHaveBeenCalledTimes(1);
    });
  });

  describe("with a capped grant", () => {
    it("hands over every request whole while the collector keeps every span", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      buffer.setOtlpExport("capped");
      buffer.setIngestMode("full");

      buffer.insertRequestSnapshot(request());
      buffer.insertJobSnapshot(job());

      expect(handedOver(otlp)).toEqual(["/orders"]);
      expect(otlp.exportJobSnapshot.mock.calls[0][1]).toBe(true);
    });

    it("hands over what Observe keeps of a paced day: the notable whole, the rest without their trees", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      buffer.setOtlpExport("capped");
      buffer.setIngestMode("paced");

      buffer.insertRequestSnapshot(request({ operationId: "/ordinary" }));
      buffer.insertRequestSnapshot(
        request({
          operationId: "/failed",
          attributes: { method: "GET", statusCode: 500, originalUrl: "/f" },
        }),
      );
      buffer.insertRequestSnapshot(
        request({ operationId: "/slow", duration: 1_500 }),
      );
      buffer.insertJobSnapshot(job({ id: "ordinary" }));
      buffer.insertJobSnapshot(
        job({ id: "failed", error: { cls: "Error", message: "boom" } }),
      );

      expect(handedOver(otlp)).toEqual([
        "/ordinary (no tree)",
        "/failed",
        "/slow",
      ]);
      expect(
        otlp.exportJobSnapshot.mock.calls.map((call) => {
          const [snapshot, withTree] = call as [JobSnapshot, boolean];
          return `${snapshot.id}:${withTree}`;
        }),
      ).toEqual(["ordinary:false", "failed:true"]);
    });

    it("hands over nothing Observe's own batch leaves out", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp, { maxTracesPerBatch: 1 });
      buffer.recordAccepted();
      buffer.setOtlpExport("capped");

      buffer.insertRequestSnapshot(request({ operationId: "/first" }));
      buffer.insertRequestSnapshot(request({ operationId: "/second" }));
      buffer.insertRequestSnapshot(
        request({ operationId: undefined, attributes: undefined }),
      );

      expect(handedOver(otlp)).toEqual(["/first"]);
    });

    it("hands over only the server errors a paused overage sends, without their trees", () => {
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      buffer.setOtlpExport("capped");
      buffer.setIngestMode("errors-only");

      buffer.insertRequestSnapshot(request({ operationId: "/ok" }));
      buffer.insertRequestSnapshot(
        request({
          operationId: "/failed",
          attributes: { method: "GET", statusCode: 503, originalUrl: "/f" },
        }),
      );

      expect(handedOver(otlp)).toEqual(["/failed (no tree)"]);
    });

    it("lapses with the replies that renew it, before the degraded window it follows", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const otlp = exporter();
      const buffer = bufferWith(otlp);
      buffer.recordAccepted();
      // As the worker posts them for one reply: the grant, then the verdict.
      buffer.setOtlpExport("capped");
      buffer.setIngestMode("paced");

      vi.setSystemTime(Date.now() + DEGRADED_TTL_MS - 1);
      buffer.insertRequestSnapshot(request({ operationId: "/inside" }));
      vi.setSystemTime(Date.now() + 1);
      buffer.insertRequestSnapshot(request({ operationId: "/after" }));

      // Not a whole tree once the window lapses: nothing at all.
      expect(handedOver(otlp)).toEqual(["/inside (no tree)"]);
      expect(buffer.otlpExportGrant()).toBe("off");
    });
  });
});

describe("ObserveAgentWorker and the OTLP export grant", () => {
  let booted: ObserveAgentWorker | undefined;

  const boot = () => {
    const resolved = options();
    const otlp = exporter();
    const buffer = new ObserveAgentSharedBuffer(
      resolved,
      undefined,
      otlp as unknown as OtlpTraceExporter,
    );
    const agent = new ObserveAgentWorker(
      buffer,
      resolved,
      {} as NodeRuntimeMetricsService,
      undefined,
      otlp as unknown as OtlpTraceExporter,
    );
    booted = agent;
    const { logger } = agent as unknown as {
      logger: { log: (m: string) => void; warn: (m: string) => void };
    };
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const exportLines = () =>
      [...log.mock.calls, ...warn.mock.calls]
        .map(([line]) => line)
        .filter((line) => line.includes("OTLP export"));
    return { agent, buffer, exportLines };
  };

  afterEach(async () => {
    await booted?.onApplicationShutdown();
    booted = undefined;
  });

  it("records each grant and says it once per change, the first answer included", () => {
    const { agent, buffer, exportLines } = boot();

    agent.handleMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}full`);
    agent.handleMessage("observe:degraded=false");
    agent.handleMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}full`);
    agent.handleMessage("observe:degraded=false");
    expect(buffer.otlpExportGrant()).toBe("full");

    agent.handleMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}capped`);
    agent.handleMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}off`);
    expect(buffer.otlpExportGrant()).toBe("off");

    expect(exportLines()).toEqual([
      "OTLP export is on: every trace this app records goes to http://127.0.0.1:4318/v1/traces.",
      expect.stringContaining("OTLP export is on, capped by this app's plan"),
      "OTLP export is off: the collector did not grant it for this app's plan, so nothing goes to http://127.0.0.1:4318/v1/traces.",
    ]);
  });

  it("says export is off when the collector's first answer grants nothing", () => {
    const { agent, buffer, exportLines } = boot();

    agent.handleMessage(`${OTLP_EXPORT_MESSAGE_PREFIX}off`);
    agent.handleMessage("observe:degraded=false");

    expect(buffer.isIngesting()).toBe(true);
    expect(buffer.otlpExportGrant()).toBe("off");
    expect(exportLines()).toEqual([
      expect.stringContaining("OTLP export is off"),
    ]);
  });
});
