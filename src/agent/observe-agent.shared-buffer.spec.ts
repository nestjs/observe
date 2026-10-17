import { Counter } from "../custom-metrics/counter.js";
import { Gauge } from "../custom-metrics/gauge.js";
import { Summary } from "../custom-metrics/summary.js";
import type { EncodedCustomMetric } from "../encoders/custom-metrics.encoder.js";
import type { EncodedJobSnapshot } from "../encoders/job-snapshot.encoder.js";
import type { EncodedRequestSnapshot } from "../encoders/request-snapshot.encoder.js";
import {
  EncodedNodeRuntimeMetrics,
  RuntimeMetricsEncoder,
} from "../encoders/runtime-metrics.encoder.js";
import type { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import type { NodeRuntimeMetrics } from "../interfaces/node-runtime-metrics.interface.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import type { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import type {
  ObjectiveDeclaration,
  ObjectivesRegistry,
} from "../objectives/objectives.registry.js";
import {
  countTraceNodes,
  DEGRADED_TTL_MS,
  IngestMode,
} from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import {
  createTelemetrySanitizer,
  MAX_BATCH_ITEMS,
  SECTION_SHAPES,
  validateTelemetryPayload,
} from "./telemetry-wire-contract.js";

const MAX_LOGS_PER_TRANSACTION = 250;
const MAX_PENDING_LOGS = 2000;
const MAX_LOG_ENTRY_LENGTH = 4 * 1024;

function createBuffer(
  overrides: Partial<ObserveModuleOptionsWithDefaults> = {},
) {
  return new ObserveAgentSharedBuffer({
    serviceId: "svc-test",
    forwardLogs: true,
    ...overrides,
  } as ObserveModuleOptionsWithDefaults);
}

const logs = (count: number, text = "line") =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: Date.now(),
    text: `${text}-${index}`,
  }));

/** The batch as it currently stands, without going through serialisation. */
const batchOf = (buffer: ObserveAgentSharedBuffer) =>
  (buffer as unknown as { _mainThreadBuffer: { logs?: unknown[] } | null })
    ._mainThreadBuffer;

const pendingOf = (buffer: ObserveAgentSharedBuffer) =>
  (buffer as unknown as { _pendingLogs: unknown[] })._pendingLogs;

/**
 * Logs are the only unbounded input the agent has: snapshots are gated by
 * `maxTracesPerBatch`, but a service stuck in a retry loop produces log lines
 * with no ceiling. Left unchecked they push the payload past the shared buffer's
 * size, the whole write throws, and noisy logging silently costs the traces and
 * metrics too. These cases are about that boundary.
 */
describe("ObserveAgentSharedBuffer", () => {
  describe("serialized traces during degraded ingestion", () => {
    type SerializedBatch = {
      serviceId: string;
      forwardLogs: boolean;
      snapshots: EncodedRequestSnapshot[];
      jobs: EncodedJobSnapshot[];
      custom?: EncodedCustomMetric[];
      runtime?: EncodedNodeRuntimeMetrics;
      logs?: unknown[];
      objectives?: ObjectiveDeclaration[];
      truncatedSpans?: number;
    };

    const traces = (): CompleteTraceEventNode[] => [
      {
        name: "Service.run",
        origin: "auto",
        className: "Service",
        methodKey: "run",
        duration: 10,
        children: [
          {
            name: "Repository.read",
            origin: "auto",
            className: "Repository",
            methodKey: "read",
            duration: 2,
            children: [],
          },
        ],
      },
    ];

    const insertOperations = (
      buffer: ObserveAgentSharedBuffer,
      request: Partial<RequestSnapshot> = {},
      job: Partial<JobSnapshot> = {},
    ) => {
      buffer.insertRequestSnapshot({
        traceId: "request-trace",
        protocol: "http",
        operationId: "/health",
        attributes: { method: "GET", statusCode: 200 },
        duration: 10,
        traces: traces(),
        ...request,
      });
      buffer.insertJobSnapshot({
        id: "job-1",
        traceId: "job-trace",
        name: "scheduled-task",
        queueName: "cron",
        status: "completed",
        duration: 10,
        traces: traces(),
        ...job,
      });
    };

    const readBatch = (buffer: ObserveAgentSharedBuffer): SerializedBatch => {
      buffer.encodeAndWrite();
      const length = new DataView(buffer.sharedBuffer, 4, 4).getUint32(0);
      return JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(buffer.sharedBuffer, 8, length),
        ),
      );
    };

    const expectTraceArrays = (batch: SerializedBatch) => {
      for (const entry of [...batch.snapshots, ...batch.jobs]) {
        expect(Array.isArray(entry.t)).toBe(true);
      }
      // The contract requires `t` as the collector does, so the batch as a
      // whole has to pass it too - `truncatedSpans` included.
      expect(validateTelemetryPayload(batch, { forbidUnknown: true })).toEqual(
        [],
      );
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("keeps nested request and job trees during normal ingestion", () => {
      const buffer = createBuffer();
      insertOperations(buffer);

      const batch = readBatch(buffer);

      expectTraceArrays(batch);
      expect(batch.snapshots[0].t?.[0].ch?.[0].n).toBe("Repository.read");
      expect(batch.jobs[0].t).toEqual(batch.snapshots[0].t);
      expect(batch).not.toHaveProperty("truncatedSpans");
    });

    it.each([10, 1_000])(
      "keeps operation rows with empty trace arrays at %i ms when degraded",
      (duration) => {
        const buffer = createBuffer();
        buffer.setIngestMode("reduced");
        insertOperations(buffer, { duration }, { duration });

        const batch = readBatch(buffer);

        expectTraceArrays(batch);
        expect(batch.snapshots).toEqual([
          {
            ti: "request-trace",
            p: "http",
            op: "/health",
            a: { m: "GET", sc: 200 },
            d: duration,
            t: [],
          },
        ]);
        expect(batch.jobs).toEqual([
          {
            i: "job-1",
            ti: "job-trace",
            n: "scheduled-task",
            q: "cron",
            s: "completed",
            d: duration,
            t: [],
          },
        ]);
        expect(batch.truncatedSpans).toBe(4);
      },
    );

    it("keeps empty trace arrays without counting spans that do not exist", () => {
      const buffer = createBuffer();
      buffer.setIngestMode("reduced");
      insertOperations(buffer, { traces: [] }, { traces: [] });

      const batch = readBatch(buffer);

      expectTraceArrays(batch);
      expect(batch.snapshots[0].t).toEqual([]);
      expect(batch.jobs[0].t).toEqual([]);
      expect(batch.truncatedSpans).toBe(0);
    });

    it.each([
      {
        label: "slow operations",
        request: { duration: 1_001 },
        job: { duration: 1_001 },
      },
      {
        label: "server errors and failed jobs",
        request: { attributes: { method: "GET", statusCode: 500 } },
        job: { status: "failed" as const, error: { message: "job failed" } },
      },
      {
        label: "errors without a status code",
        request: {
          protocol: "rpc",
          attributes: {},
          error: { message: "failed" },
        },
        job: { error: { message: "job failed" } },
      },
    ])("keeps nested trees for $label when degraded", ({ request, job }) => {
      const buffer = createBuffer();
      buffer.setIngestMode("reduced");
      insertOperations(buffer, request, job);

      const batch = readBatch(buffer);

      expectTraceArrays(batch);
      expect(batch.snapshots[0].t?.[0].ch?.[0].n).toBe("Repository.read");
      expect(batch.jobs[0].t).toEqual(batch.snapshots[0].t);
      expect(batch).not.toHaveProperty("truncatedSpans");
    });

    it("still withholds fast HTTP client errors when degraded", () => {
      const buffer = createBuffer();
      buffer.setIngestMode("reduced");
      insertOperations(buffer, {
        attributes: { statusCode: 499 },
        error: { message: "client error" },
      });

      const batch = readBatch(buffer);

      expectTraceArrays(batch);
      expect(batch.snapshots[0].t).toEqual([]);
      expect(batch.snapshots[0].e).toEqual({ message: "client error" });
      expect(batch.truncatedSpans).toBe(4);
    });

    it.each(["cleared", "expired"])(
      "restores subsequent request and job trees when degradation is %s",
      (recovery) => {
        vi.useFakeTimers();
        const buffer = createBuffer();
        buffer.setIngestMode("reduced");
        insertOperations(buffer);
        const degraded = readBatch(buffer);
        expectTraceArrays(degraded);
        expect(degraded.snapshots[0].t).toEqual([]);
        expect(degraded.jobs[0].t).toEqual([]);

        buffer.resetMainThreadBuffer();
        if (recovery === "cleared") {
          buffer.setIngestMode("full");
        } else {
          vi.advanceTimersByTime(DEGRADED_TTL_MS + 1);
        }
        insertOperations(buffer);
        const recovered = readBatch(buffer);

        expectTraceArrays(recovered);
        expect(recovered.snapshots[0].t?.[0].ch?.[0].n).toBe("Repository.read");
        expect(recovered.jobs[0].t).toEqual(recovered.snapshots[0].t);
        expect(recovered).not.toHaveProperty("truncatedSpans");
      },
    );

    it("keeps trace arrays and labeled metrics when repairing an unrelated field", () => {
      const buffer = createBuffer();
      buffer.setIngestMode("reduced");
      insertOperations(buffer);
      const counter = new Counter("task.runs", "Runs", ["result"]);
      counter.increment({ result: "completed" }, 3);
      const gauge = new Gauge("task.pending", { labels: ["queue"] });
      gauge.increment({ queue: "cron" }, 0);
      gauge.setValue({ queue: "cron" }, 2);
      const summary = new Summary("task.duration", { labels: ["cron"] });
      summary.observe(42, "cron");
      for (const metric of [counter, gauge, summary]) {
        buffer.upsertCustomMetric(metric);
      }
      const batch = readBatch(buffer);
      const expectedMetrics = structuredClone(batch.custom);
      expect(batch.custom).toHaveLength(3);
      expect(batch.custom?.map((metric) => metric.l)).toEqual([
        ["result"],
        ["queue"],
        ["cron"],
      ]);
      batch.jobs[0].st = 123;
      // The worker rebuilds the sanitizer from source without module scope.
      const workerSanitizer = new Function(
        `return (${createTelemetrySanitizer.toString()})`,
      )()(SECTION_SHAPES);

      const result = workerSanitizer.sanitizeBatch(batch);

      expect(result.changed).toBe(true);
      expect(result.dropped).toBe(0);
      expect(batch.jobs[0]).not.toHaveProperty("st");
      expect(batch.custom).toEqual(expectedMetrics);
      expectTraceArrays(batch);
      expect(batch.snapshots[0].t).toEqual([]);
      expect(batch.jobs[0].t).toEqual([]);
      expect(batch.truncatedSpans).toBe(4);
    });

    /**
     * A paying account whose overage is paused: the collector keeps its
     * server errors, without their trees, and nothing else that is billed.
     */
    describe("while only server errors are kept", () => {
      /** A tree of `nodes` spans: a handler and what it called. */
      const tree = (nodes: number): CompleteTraceEventNode[] => [
        {
          name: "Handler.run",
          origin: "auto",
          className: "Handler",
          methodKey: "run",
          duration: 5,
          children: Array.from({ length: nodes - 1 }, (_, index) => ({
            name: `Repository.read${index}`,
            origin: "auto" as const,
            className: "Repository",
            methodKey: `read${index}`,
            duration: 1,
            children: [],
          })),
        },
      ];

      /** A fast, successful request with a one-span tree, unless overridden. */
      const request = (
        name: string,
        overrides: Partial<RequestSnapshot> = {},
      ): RequestSnapshot => ({
        traceId: name,
        protocol: "http",
        operationId: `/${name}`,
        attributes: { method: "GET", statusCode: 200 },
        duration: 10,
        traces: tree(1),
        ...overrides,
      });

      /** A fast job that completed, with a one-span tree, unless overridden. */
      const job = (
        name: string,
        overrides: Partial<JobSnapshot> = {},
      ): JobSnapshot => ({
        id: name,
        traceId: `${name}-trace`,
        name,
        queueName: "cron",
        status: "completed",
        duration: 10,
        traces: tree(1),
        ...overrides,
      });

      const runtime: NodeRuntimeMetrics = {
        cpu: { user: 1, system: 2, percentageUsed: 33 },
        memory: {
          rss: 100,
          heapTotal: 200,
          heapUsed: 150,
          external: 10,
          percentageUsed: 44,
        },
        gc: { count: 3, totalDuration: 12 },
        eventLoop: { lag: 7, utilization: 0.5 },
      };

      /** What the collector validates every batch against, unknown keys refused. */
      const expectValid = (batch: SerializedBatch) => {
        expect(
          validateTelemetryPayload(batch, { forbidUnknown: true }),
        ).toEqual([]);
      };

      const sentIds = (batch: SerializedBatch) =>
        [...(batch.snapshots ?? []), ...(batch.jobs ?? [])].map(
          (entry) => entry.ti,
        );

      it("sends the server errors alone, without their trees, and reports everything withheld in billed units", () => {
        const declaration: ObjectiveDeclaration = {
          handler: "HealthController.check",
          operationId: "/health",
          method: "GET",
          objectives: [{ availability: 99.9 }],
        };
        const registry = {
          declarationFor: (snapshot: RequestSnapshot) =>
            snapshot.operationId === "/health" ? declaration : undefined,
        } as unknown as ObjectivesRegistry;
        const buffer = new ObserveAgentSharedBuffer(
          {
            serviceId: "svc-test",
            forwardLogs: true,
          } as ObserveModuleOptionsWithDefaults,
          registry,
        );
        buffer.setIngestMode("errors-only");

        // Each withheld event counts one, as the meter would have billed it.
        // A fast success: the request and its 3 spans.                    4
        buffer.insertRequestSnapshot(request("health", { traces: tree(3) }));
        // A slow success is notable, and still no server error: 1 + 2.     3
        buffer.insertRequestSnapshot(
          request("report", { duration: 5_000, traces: tree(2) }),
        );
        // A client error: the request, the error it carried, 2 spans.      4
        buffer.insertRequestSnapshot(
          request("missing", {
            attributes: { method: "GET", statusCode: 404 },
            error: { message: "Not Found" },
            traces: tree(2),
          }),
        );
        // A server error is sent; its 5 spans are not.                      5
        buffer.insertRequestSnapshot(
          request("checkout", {
            attributes: { method: "POST", statusCode: 503 },
            error: { message: "payments unavailable" },
            traces: tree(5),
          }),
        );
        // A job that completed: the job and its span.                       2
        buffer.insertJobSnapshot(job("sync"));
        // A job that failed is sent; its 2 spans are not.                   2
        buffer.insertJobSnapshot(
          job("import", {
            status: "failed",
            error: { message: "import failed" },
            traces: tree(2),
          }),
        );
        // Every log record, error level included.                           3
        buffer.pushLogs([
          { timestamp: Date.now(), level: "log", text: "served /health" },
          { timestamp: Date.now(), level: "warn", text: "report took 5 s" },
          { timestamp: Date.now(), level: "error", text: "payments down" },
        ]);
        // Not events: these ride as ever.
        buffer.addNodeRuntimeMetrics(runtime);
        const placed = new Counter("orders.placed");
        placed.increment();
        buffer.upsertCustomMetric(placed);

        const batch = readBatch(buffer);

        expect(batch.snapshots).toEqual([
          {
            ti: "checkout",
            p: "http",
            op: "/checkout",
            a: { m: "POST", sc: 503 },
            d: 10,
            e: { message: "payments unavailable" },
            t: [],
          },
        ]);
        expect(batch.jobs).toEqual([
          {
            i: "import",
            ti: "import-trace",
            n: "import",
            q: "cron",
            s: "failed",
            d: 10,
            e: { message: "import failed" },
            t: [],
          },
        ]);
        expect(batch).not.toHaveProperty("logs");
        expect(batch.truncatedSpans).toBe(4 + 3 + 4 + 5 + 2 + 2 + 3);
        expect(batch.runtime).toEqual(RuntimeMetricsEncoder.encode(runtime));
        expect(batch.custom?.map((metric) => metric.n)).toEqual([
          "orders.placed",
        ]);
        // Declarations are not telemetry: the health check was withheld and
        // still brought its handler's objectives due.
        expect(batch.objectives).toEqual([declaration]);
        expectValid(batch);
      });

      it.each<[string, Partial<RequestSnapshot>, boolean]>([
        [
          "a server error",
          {
            attributes: { method: "GET", statusCode: 500 },
            error: { message: "boom" },
          },
          true,
        ],
        // The status decides alone, both ways.
        [
          "a 5xx without an error object",
          { attributes: { method: "GET", statusCode: 502 } },
          true,
        ],
        [
          "a 4xx carrying an error",
          {
            attributes: { method: "GET", statusCode: 401 },
            error: { message: "Unauthorized" },
          },
          false,
        ],
        ["a slow success", { duration: 30_000 }, false],
        // No status code - an RPC, a socket message - and the error decides.
        [
          "an errored request without a status code",
          { protocol: "rpc", attributes: {}, error: { message: "failed" } },
          true,
        ],
        ["a request with neither", { protocol: "rpc", attributes: {} }, false],
      ])("grades %s as sent: %s", (_label, overrides, sent) => {
        const buffer = createBuffer();
        buffer.setIngestMode("errors-only");

        buffer.insertRequestSnapshot(
          request("op", { traces: tree(2), ...overrides }),
        );
        const batch = readBatch(buffer);

        expect(sentIds(batch)).toEqual(sent ? ["op"] : []);
        expect(batch.snapshots.flatMap((snapshot) => snapshot.t)).toEqual([]);
        // Its 2 spans either way; the request and its error only if withheld.
        expect(batch.truncatedSpans).toBe(
          sent ? 2 : 3 + (overrides.error ? 1 : 0),
        );
        expectValid(batch);
      });

      it.each<[string, Partial<JobSnapshot>, boolean]>([
        [
          "a failed job",
          { status: "failed", error: { message: "boom" } },
          true,
        ],
        ["a completed job", {}, false],
        // Slow is not failed.
        ["a slow job", { duration: 60_000 }, false],
      ])("grades %s as sent: %s", (_label, overrides, sent) => {
        const buffer = createBuffer();
        buffer.setIngestMode("errors-only");

        buffer.insertJobSnapshot(
          job("work", { traces: tree(2), ...overrides }),
        );
        const batch = readBatch(buffer);

        expect(sentIds(batch)).toEqual(sent ? ["work-trace"] : []);
        expect(batch.jobs.flatMap((entry) => entry.t)).toEqual([]);
        expect(batch.truncatedSpans).toBe(
          sent ? 2 : 3 + (overrides.error ? 1 : 0),
        );
        expectValid(batch);
      });

      it("withholds the log records a batch would have carried, and counts each", () => {
        const buffer = createBuffer();
        // Written before the pause began, and withheld all the same: the
        // batch is written while it holds.
        buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + 30));
        buffer.setIngestMode("errors-only");

        const first = readBatch(buffer);
        expect(first).not.toHaveProperty("logs");
        // A batch's worth, as outside a pause - not every line written, some
        // of which no batch was ever going to carry.
        expect(first.truncatedSpans).toBe(MAX_LOGS_PER_TRANSACTION);
        expectValid(first);

        // The backlog is drained, and counted, a batch at a time.
        buffer.resetMainThreadBuffer();
        buffer.drainPendingLogs();
        const second = readBatch(buffer);
        expect(second).not.toHaveProperty("logs");
        expect(second.truncatedSpans).toBe(30);
        expectValid(second);
      });

      it("still sends a batch that withheld everything, so the count arrives and the reply renews the pause", () => {
        const buffer = createBuffer();
        buffer.setIngestMode("errors-only");

        buffer.insertRequestSnapshot(request("health"));

        expect(buffer.isBufferEmpty()).toBe(false);
        const batch = readBatch(buffer);
        expect(batch).toEqual({
          serviceId: "svc-test",
          forwardLogs: true,
          snapshots: [],
          truncatedSpans: 2,
        });
        expectValid(batch);
      });

      it("counts a withheld execution against maxTracesPerBatch, as though it had been sent", () => {
        const buffer = createBuffer({ maxTracesPerBatch: 2 });
        buffer.setIngestMode("errors-only");

        buffer.insertRequestSnapshot(request("health"));
        buffer.insertRequestSnapshot(
          request("failing", {
            attributes: { method: "GET", statusCode: 500 },
          }),
        );
        buffer.insertJobSnapshot(job("sync"));
        buffer.insertJobSnapshot(
          job("import", { status: "failed", error: { message: "failed" } }),
        );
        // A third of each would not have fitted a batch outside a pause
        // either: neither graded nor counted.
        buffer.insertRequestSnapshot(
          request("late", { attributes: { method: "GET", statusCode: 500 } }),
        );
        buffer.insertJobSnapshot(
          job("retry", { status: "failed", error: { message: "failed" } }),
        );

        const batch = readBatch(buffer);
        expect(sentIds(batch)).toEqual(["failing", "import-trace"]);
        expect(batch.truncatedSpans).toBe(2 + 1 + 2 + 1);

        // The next batch starts its count over.
        buffer.resetMainThreadBuffer();
        buffer.insertRequestSnapshot(
          request("late", { attributes: { method: "GET", statusCode: 500 } }),
        );
        buffer.insertJobSnapshot(
          job("retry", { status: "failed", error: { message: "failed" } }),
        );
        expect(sentIds(readBatch(buffer))).toEqual(["late", "retry-trace"]);
      });

      it("lapses on its own when no reply renews it", () => {
        vi.useFakeTimers();
        const buffer = createBuffer();
        buffer.setIngestMode("errors-only");

        vi.advanceTimersByTime(DEGRADED_TTL_MS + 1);
        expect(buffer.isErrorsOnly()).toBe(false);
        expect(buffer.isDegraded()).toBe(false);

        buffer.insertRequestSnapshot(request("health", { traces: tree(3) }));
        buffer.pushLogs(logs(2));
        const batch = readBatch(buffer);
        expect(sentIds(batch)).toEqual(["health"]);
        expect(countTraceNodes(batch.snapshots[0].t)).toBe(3);
        expect(batch.logs).toHaveLength(2);
        expect(batch).not.toHaveProperty("truncatedSpans");
      });

      it("slides with every reply that is still errors-only", () => {
        vi.useFakeTimers();
        const buffer = createBuffer();
        buffer.setIngestMode("errors-only");

        vi.advanceTimersByTime(DEGRADED_TTL_MS - 1);
        buffer.setIngestMode("errors-only");
        vi.advanceTimersByTime(DEGRADED_TTL_MS - 1);

        expect(buffer.isErrorsOnly()).toBe(true);
      });

      it.each<[IngestMode, boolean]>([
        ["reduced", true],
        ["trimmed", true],
        ["paced", true],
        ["full", false],
      ])(
        "gives way at once to a `%s` reply (trees still withheld: %s)",
        (mode, degraded) => {
          const buffer = createBuffer();
          buffer.setIngestMode("errors-only");

          buffer.setIngestMode(mode);

          expect(buffer.isErrorsOnly()).toBe(false);
          expect(buffer.isDegraded()).toBe(degraded);
          // Sent again, as that reply says: its tree withheld if it is not
          // notable and trees are, whole otherwise - and the logs with it.
          buffer.insertRequestSnapshot(request("health", { traces: tree(3) }));
          buffer.pushLogs(logs(2));
          const batch = readBatch(buffer);
          expect(sentIds(batch)).toEqual(["health"]);
          expect(countTraceNodes(batch.snapshots[0].t)).toBe(degraded ? 0 : 3);
          expect(batch.truncatedSpans).toBe(degraded ? 3 : undefined);
          expect(batch.logs).toHaveLength(2);
        },
      );
    });
  });

  describe("empty state", () => {
    it("starts empty", () => {
      expect(createBuffer().isBufferEmpty()).toBe(true);
    });

    it("stops being empty once something is buffered", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(1));

      expect(buffer.isBufferEmpty()).toBe(false);
    });

    it("is empty again after a reset", () => {
      const buffer = createBuffer();
      buffer.pushLogs(logs(1));

      buffer.resetMainThreadBuffer();

      expect(buffer.isBufferEmpty()).toBe(true);
    });
  });

  describe("log batching", () => {
    it("keeps everything that fits in one batch", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(10));

      expect(batchOf(buffer)!.logs).toHaveLength(10);
      expect(pendingOf(buffer)).toHaveLength(0);
    });

    it("caps a batch and holds the remainder back", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + 50));

      // Deferred rather than discarded: a burst that exceeds one batch is the
      // most interesting thing the logs will ever carry.
      expect(batchOf(buffer)!.logs).toHaveLength(MAX_LOGS_PER_TRANSACTION);
      expect(pendingOf(buffer)).toHaveLength(50);
    });

    it("bounds the backlog rather than growing without limit", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + MAX_PENDING_LOGS + 500));

      // Dropping telemetry is recoverable; taking the host process down with an
      // ever-growing array is not.
      expect(batchOf(buffer)!.logs).toHaveLength(MAX_LOGS_PER_TRANSACTION);
      expect(pendingOf(buffer)).toHaveLength(MAX_PENDING_LOGS);
    });

    it("drops the newest lines when both are full", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + MAX_PENDING_LOGS + 10));

      // During a burst the opening lines usually explain it; losing the tail of
      // a retry storm costs less than losing its first cause.
      const batch = batchOf(buffer)!.logs as Array<{ text: string }>;
      expect(batch[0].text).toBe("line-0");
    });

    it("does not write to stdout when it drops", () => {
      // `pushLogs` is called from the patched `process.stdout.write`, so a log
      // line here would re-enter, drop, and log again - unbounded recursion.
      const buffer = createBuffer({ debug: true });
      const write = vi
        .spyOn(process.stdout, "write")
        .mockImplementation(() => true);

      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + MAX_PENDING_LOGS + 10));

      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    });
  });

  describe("oversized entries", () => {
    it("truncates a line past the per-entry limit", () => {
      const buffer = createBuffer();

      buffer.pushLogs([
        { timestamp: Date.now(), text: "x".repeat(MAX_LOG_ENTRY_LENGTH * 3) },
      ]);

      // One serialised payload dump can be megabytes on its own, so the count
      // cap alone does not bound the batch.
      const [entry] = batchOf(buffer)!.logs as Array<{ text: string }>;
      expect(entry.text.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_LENGTH);
      expect(entry.text).toMatch(/\[truncated by observe\]$/);
    });

    it("leaves a line inside the limit untouched", () => {
      const buffer = createBuffer();
      const text = "y".repeat(100);

      buffer.pushLogs([{ timestamp: Date.now(), text }]);

      const [entry] = batchOf(buffer)!.logs as Array<{ text: string }>;
      expect(entry.text).toBe(text);
    });

    it("truncates lines held in the backlog too", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION));
      buffer.pushLogs([
        { timestamp: Date.now(), text: "z".repeat(MAX_LOG_ENTRY_LENGTH * 2) },
      ]);

      const [pending] = pendingOf(buffer) as Array<{ text: string }>;
      expect(pending.text.length).toBeLessThanOrEqual(MAX_LOG_ENTRY_LENGTH);
    });
  });

  describe("draining the backlog", () => {
    it("tops a partly-filled batch up from the backlog", () => {
      const buffer = createBuffer();
      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + 20));
      buffer.resetMainThreadBuffer();

      buffer.drainPendingLogs();

      // Without this the backlog strands itself: the process goes quiet, no new
      // `pushLogs` runs to move the lines, and the buffer reads as empty while
      // holding them until shutdown.
      expect(batchOf(buffer)!.logs).toHaveLength(20);
      expect(pendingOf(buffer)).toHaveLength(0);
    });

    it("does nothing when the backlog is empty", () => {
      const buffer = createBuffer();

      buffer.drainPendingLogs();

      expect(buffer.isBufferEmpty()).toBe(true);
    });

    it("does not overfill a batch that is already at capacity", () => {
      const buffer = createBuffer();
      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION + 100));

      buffer.drainPendingLogs();

      expect(batchOf(buffer)!.logs).toHaveLength(MAX_LOGS_PER_TRANSACTION);
      expect(pendingOf(buffer)).toHaveLength(100);
    });

    it("drains across several batches", () => {
      const buffer = createBuffer();
      buffer.pushLogs(logs(MAX_LOGS_PER_TRANSACTION * 3));

      let drained = 0;
      for (let batch = 0; batch < 2; batch++) {
        buffer.resetMainThreadBuffer();
        buffer.drainPendingLogs();
        drained += (batchOf(buffer)!.logs as unknown[]).length;
      }

      expect(drained).toBe(MAX_LOGS_PER_TRANSACTION * 2);
      expect(pendingOf(buffer)).toHaveLength(0);
    });
  });

  describe("request snapshot operation id", () => {
    const requestSnapshot = (overrides: Record<string, unknown> = {}) =>
      ({
        traceId: "trace-1",
        protocol: "http",
        traces: [],
        ...overrides,
      }) as never;

    const snapshotsOf = (buffer: ObserveAgentSharedBuffer) =>
      (batchOf(buffer) as { snapshots?: Array<{ op?: string; ou?: string }> })
        ?.snapshots;

    const PROJECT = "b0c013f1-5ebc-444f-8f40-6c0ea68150e9";
    const PREFLIGHT_URL = `/me/projects/${PROJECT}/telemetry/dashboard?timeInterval=30d`;

    it("keeps the operation id when one was captured", () => {
      const buffer = createBuffer();

      // Matched routes are never folded, even one spelled with a `?` - an
      // Express optional parameter - which a fallback would be cut at.
      buffer.insertRequestSnapshot(
        requestSnapshot({
          operationId: "/me/projects/:projectId/telemetry/dashboard",
          attributes: { originalUrl: PREFLIGHT_URL },
        }),
      );
      buffer.insertRequestSnapshot(
        requestSnapshot({
          traceId: "trace-2",
          operationId: "/users/:id?",
          attributes: { originalUrl: "/users/42" },
        }),
      );

      expect(snapshotsOf(buffer)).toEqual([
        expect.objectContaining({
          op: "/me/projects/:projectId/telemetry/dashboard",
        }),
        expect.objectContaining({ op: "/users/:id?" }),
      ]);
    });

    it("falls back to the request URL when no route was resolved", () => {
      const buffer = createBuffer();

      // A guard rejecting the request, or a GraphQL document that never
      // reaches a resolver, ends the trace before route metadata exists.
      buffer.insertRequestSnapshot(
        requestSnapshot({ attributes: { originalUrl: "/graphql" } }),
      );

      expect(snapshotsOf(buffer)).toEqual([
        expect.objectContaining({ op: "/graphql" }),
      ]);
    });

    it("folds a fallback URL to its path, ids replaced", () => {
      const buffer = createBuffer();

      // A CORS preflight is answered by the cors middleware before any route
      // matches. Sent verbatim, each project id and query string would be a
      // route of its own in every per-route rollup.
      buffer.insertRequestSnapshot(
        requestSnapshot({
          attributes: { method: "OPTIONS", originalUrl: PREFLIGHT_URL },
        }),
      );

      // Only the grouping key is folded: the URL itself still travels whole.
      expect(snapshotsOf(buffer)).toEqual([
        expect.objectContaining({
          op: "/me/projects/:id/telemetry/dashboard",
          a: expect.objectContaining({ ou: PREFLIGHT_URL }),
        }),
      ]);
    });

    it("keeps a GraphQL document fallback as it is", () => {
      const buffer = createBuffer();
      const document = 'query { search(q: "why?") { id } }';

      // The document is not a path, and the `?` in its string literal is not
      // a query string to cut at.
      buffer.insertRequestSnapshot(
        requestSnapshot({
          protocol: "graphql",
          attributes: { originalUrl: document },
        }),
      );

      expect(snapshotsOf(buffer)).toEqual([
        expect.objectContaining({ op: document }),
      ]);
    });

    it("drops a snapshot with neither, keeping the batch shippable", () => {
      const buffer = createBuffer();
      buffer.insertRequestSnapshot(
        requestSnapshot({ operationId: "/healthy" }),
      );

      // The collector rejects a whole batch over one snapshot missing its
      // operation id, so the unlabelable snapshot must never ride along.
      buffer.insertRequestSnapshot(requestSnapshot({ traceId: "trace-2" }));

      expect(snapshotsOf(buffer)).toEqual([
        expect.objectContaining({ op: "/healthy" }),
      ]);
    });
  });

  describe("job snapshot cap", () => {
    it("caps job snapshots at maxTracesPerBatch, same as request snapshots", () => {
      const buffer = createBuffer({ maxTracesPerBatch: 3 });

      for (let index = 0; index < 5; index += 1) {
        buffer.insertJobSnapshot({ name: `job-${index}` } as never);
      }

      // The buffer only empties when a flush succeeds, so without this cap a
      // stalled flush on the worker service would grow the array unboundedly.
      expect((batchOf(buffer) as { jobs?: unknown[] }).jobs).toHaveLength(3);
    });

    it("holds maxTracesPerBatch to the most the collector accepts", () => {
      const buffer = createBuffer({ maxTracesPerBatch: 10_000 });

      for (let index = 0; index <= MAX_BATCH_ITEMS; index += 1) {
        buffer.insertJobSnapshot({ name: `job-${index}` } as never);
      }

      // It refuses a batch holding more whole - every job in it lost, rather
      // than the overflow.
      expect((batchOf(buffer) as { jobs?: unknown[] }).jobs).toHaveLength(
        MAX_BATCH_ITEMS,
      );
    });
  });

  describe("payload metadata", () => {
    it("stamps the service id on the batch", () => {
      const buffer = createBuffer();

      buffer.pushLogs(logs(1));

      expect(batchOf(buffer)).toMatchObject({ serviceId: "svc-test" });
    });

    it("reports whether log forwarding is on", () => {
      const on = createBuffer({ forwardLogs: true });
      const off = createBuffer({ forwardLogs: false });
      on.pushLogs(logs(1));
      off.pushLogs(logs(1));

      // Self-reported, because an app with forwarding on that logged nothing
      // sends no `logs` array either - presence alone cannot tell "quiet" from
      // "never configured".
      expect(batchOf(on)).toMatchObject({ forwardLogs: true });
      expect(batchOf(off)).toMatchObject({ forwardLogs: false });
    });

    it("includes the service version only when one is configured", () => {
      const versioned = createBuffer({ serviceVersion: "1.2.3" });
      const unversioned = createBuffer();
      versioned.pushLogs(logs(1));
      unversioned.pushLogs(logs(1));

      expect(batchOf(versioned)).toMatchObject({ serviceVersion: "1.2.3" });
      expect(batchOf(unversioned)).not.toHaveProperty("serviceVersion");
    });
  });

  describe("locking", () => {
    it("starts unlocked", () => {
      expect(createBuffer().isBufferLocked()).toBe(false);
    });

    it("acquires and reports the lock", () => {
      const buffer = createBuffer();

      expect(buffer.acquireLock()).not.toBe(false);
      expect(buffer.isBufferLocked()).toBe(true);
    });

    it("refuses a second acquisition while held", () => {
      const buffer = createBuffer();
      buffer.acquireLock();

      // The worker and the main thread share this buffer; two writers at once
      // would interleave bytes into an unparseable payload.
      expect(buffer.acquireLock()).toBe(false);
    });
  });

  describe("handing a batch to the worker", () => {
    it("reports a written batch as awaiting the worker until the slot is cleared", () => {
      const buffer = createBuffer();
      expect(buffer.hasBatchAwaitingWorker()).toBe(false);

      buffer.pushLogs(logs(1));
      buffer.encodeAndWrite();
      expect(buffer.hasBatchAwaitingWorker()).toBe(true);

      // What the worker does once the collector has answered: zero the length
      // in the same shared memory, then release the lock.
      new DataView(buffer.sharedBuffer, 4, 4).setUint32(0, 0);
      expect(buffer.hasBatchAwaitingWorker()).toBe(false);
    });
  });

  describe("custom metrics", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("keeps one entry for a metric whose name is cut to fit", () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const buffer = createBuffer();
      const counter = new Counter(`orders.${"placed.".repeat(20)}total`);

      counter.increment();
      buffer.upsertCustomMetric(counter);
      counter.increment();
      buffer.upsertCustomMetric(counter);

      // Matched against the name as sent, the second change updates the
      // first entry instead of buffering the metric twice.
      const { custom } = batchOf(buffer) as unknown as {
        custom: Array<{ n: string; v: Record<string, number> }>;
      };
      expect(custom).toHaveLength(1);
      expect(custom[0].n).toHaveLength(100);
      expect(custom[0].v).toEqual({ default: 2 });
    });
  });
});
