import {
  countTraceNodes,
  DEGRADED_TTL_MS,
  IngestMode,
  isNotableSnapshot,
  isServerErrorSnapshot,
} from "./degraded-ingest.protocol.js";
import { MAX_BATCH_ITEMS } from "./telemetry-wire-contract.js";
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Counter, Gauge, Summary } from "../custom-metrics/index.js";
import {
  ObjectiveDeclaration,
  ObjectivesRegistry,
} from "../objectives/objectives.registry.js";
import {
  CustomMetricsEncoder,
  EncodedCustomMetric,
} from "../encoders/custom-metrics.encoder.js";
import {
  EncodedJobSnapshot,
  JobSnapshotEncoder,
} from "../encoders/job-snapshot.encoder.js";
import {
  EncodedRequestSnapshot,
  RequestSnapshotEncoder,
} from "../encoders/request-snapshot.encoder.js";
import {
  EncodedNodeRuntimeMetrics,
  RuntimeMetricsEncoder,
} from "../encoders/runtime-metrics.encoder.js";
import { CustomMetric } from "../interfaces/custom-metric.interface.js";
import { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import { NodeRuntimeMetrics } from "../interfaces/node-runtime-metrics.interface.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import type { OtlpExportGrant } from "../otlp/otlp-export-grant.js";
import { OtlpTraceExporter } from "../otlp/otlp-trace-exporter.service.js";
import { fallbackOperationId } from "../utils/fallback-operation-id.util.js";

const SHARED_BUFFER_SIZE = 1024 * 1024 * 16; // 16 MB
const DEFAULT_MAX_SNAPSHOTS_PER_TRANSACTION = 1000;

/**
 * Caps on the log portion of a batch.
 *
 * Logs are the one input with no natural ceiling - snapshots are gated by
 * `maxTracesPerBatch` and their largest caller-chosen field, the GraphQL
 * document, is capped where it is parsed - but a chatty service (or one stuck
 * in a retry loop) produces log lines without limit. Left uncapped they grow
 * the payload past `SHARED_BUFFER_SIZE`, and `encodeAndWrite` then throws for
 * the whole batch, so noisy logging silently costs you the traces and metrics
 * too.
 *
 * Both limits are needed: the count bounds ordinary chatter, and the per-entry
 * length bounds the single pathological line - a serialised payload dump or a
 * deep stack trace can be megabytes on its own.
 */
const MAX_LOGS_PER_TRANSACTION = 250;
const MAX_LOG_ENTRY_LENGTH = 4 * 1024; // 4 KB
const TRUNCATION_SUFFIX = "... [truncated by observe]";

/**
 * Log lines held back for a later batch when the current one is full.
 *
 * The per-batch cap bounds the *request*; this bounds the *process*. Together
 * they let a batch stay small - at most 250 lines - while up to 2250 can be in
 * flight overall, so a burst larger than one batch spills here instead of
 * being thrown away.
 *
 * Bounded because this is the one input with no natural limit. A process stuck
 * in a retry loop must eventually lose lines rather than grow this array until
 * the heap gives out - dropping telemetry is recoverable, taking the host
 * process down with it is not.
 */
const MAX_PENDING_LOGS = 2000;

/**
 * A log line waiting to be shipped.
 *
 * `level`, `context` and `attributes` are optional because they only exist for
 * lines the parser could classify - raw stdout that matches no known format is
 * still forwarded, carrying just its text.
 */
interface BufferedLogEntry {
  /**
   * Timestamp of the log entry in milliseconds since epoch.
   */
  timestamp: number;

  /**
   * Trace the line was emitted under, when one could be resolved.
   */
  traceId?: string;

  /**
   * Span the line was written inside, when one could be resolved. Only ever set
   * together with `traceId`, and only when that trace is the one the async
   * store is currently in - see StdoutForwarderService#toLogEntry.
   */
  spanId?: string;

  /**
   * Severity, lowercased to match the API's LogLevel values.
   */
  level?: string;

  /**
   * Nest logger context - the emitting class name, usually.
   */
  context?: string;

  /**
   * Fields a structured log carried beyond the modelled ones.
   */
  attributes?: Record<string, unknown>;

  /**
   * Text content of the log entry.
   */
  text: string;
}

/** Declarations one batch carries at most - the collector's own limit. */
const MAX_OBJECTIVES_PER_BATCH = 100;

/**
 * Payload structure for the agent metrics.
 * This payload is used to send metrics from the main thread to the worker thread.
 * It includes service information, request snapshots, runtime metrics, and custom metrics.
 */
interface AgentMetricsPayload {
  /**
   * Unique identifier for the service.
   */
  serviceId: string;
  /**
   * The release the process is running, as configured or inferred (see
   * `ObserveOptions.serviceVersion`). Absent when there is neither.
   */
  serviceVersion?: string;
  /**
   * Objectives declared with `@Objective`, each paired with the route its
   * handler was seen to serve (see ObjectivesRegistry).
   */
  objectives?: ObjectiveDeclaration[];
  /**
   * Spans built and then withheld because the collector reported this
   * account's ingestion is reduced, trimmed or paced.
   *
   * Reported because it cannot be inferred: the trees are not sent, so the
   * collector has no way to count the volume it is meant to be measuring the
   * account against. Without it, upgrading the agent would quietly earn an
   * account a longer reduced window - free service as a reward for behaving
   * well, which is the wrong incentive to build.
   *
   * While the account's overage is paused (`errors-only`) it carries
   * everything withheld, in the units the meter bills: one per request or job
   * not sent and one more for the error it carried, one per node of every
   * tree - those stripped from the server errors that are sent included - and
   * one per log record. The collector's design reuses this field for it: a
   * paused account's batch adds it to what the pause held back, off the bill,
   * which is the count the collector keeps when it does the filtering itself.
   */
  truncatedSpans?: number;
  /**
   * Whether this agent is forwarding logs.
   *
   * Reported on every batch rather than inferred from `logs` being present: a
   * service that has forwarding on but happened to log nothing this window is
   * indistinguishable from one that never enabled it, and that ambiguity is
   * exactly what the dashboard cannot resolve on its own.
   */
  forwardLogs?: boolean;
  /**
   * Array of encoded request snapshots.
   * Each snapshot contains information about a specific request,
   * including its traces, tags, and other metadata.
   */
  snapshots: EncodedRequestSnapshot[];
  /**
   * Node runtime metrics collected during the request processing.
   * This can include memory usage, CPU load, event loop delay, etc.
   */
  runtime?: EncodedNodeRuntimeMetrics;
  /**
   * Custom metrics collected during the request processing.
   * This can include counters or gauges that provide additional insights into the service's performance.
   */
  custom?: Array<EncodedCustomMetric>;
  /**
   * Optional array of log entries.
   * Each log entry contains a timestamp and the text content of the log.
   * If `forwardLogs` is enabled in the options, logs will be included here.
   */
  logs?: Array<BufferedLogEntry>;
  /**
   * Array of job snapshots.
   */
  jobs?: Array<EncodedJobSnapshot>;
}

@Injectable()
export class ObserveAgentSharedBuffer {
  private readonly _sharedBuffer = new SharedArrayBuffer(SHARED_BUFFER_SIZE);
  private readonly lock = new Int32Array(this._sharedBuffer, 0, 1);
  private readonly sharedBytes = new Uint8Array(this._sharedBuffer);
  private readonly encoder = new TextEncoder();
  private readonly logger = new Logger(ObserveAgentSharedBuffer.name);
  private _mainThreadBuffer: AgentMetricsPayload | null = null;
  /** See `reportUnencodableMetric`. */
  private hasReportedUnencodableMetric = false;

  /**
   * Log lines that did not fit the current batch, oldest first. Survives
   * `resetMainThreadBuffer` on purpose - it is the queue the batches are drawn
   * from, not part of any one of them.
   */
  private readonly _pendingLogs: BufferedLogEntry[] = [];

  /**
   * Metrics reporting a per-window quantity that is sitting in the current
   * buffer - a counter's increase, a summary's distribution - held so their
   * window can be closed once the payload is actually written.
   */
  private readonly _awaitingFlushAck = new Set<Counter<any> | Summary<any>>();

  /** Metrics changed in the current buffer, encoded as it is written. */
  private readonly _metricsToEncode = new Set<
    Counter<any> | Gauge<any> | Summary<any>
  >();

  get sharedBuffer() {
    return this._sharedBuffer;
  }

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    // Optional so the buffer can be built on its own, as most of its suites
    // build it; the module always provides it.
    @Optional()
    private readonly objectivesRegistry?: ObjectivesRegistry,
    // Optional for the same reason.
    @Optional()
    private readonly otlpTraceExporter?: OtlpTraceExporter,
  ) {}

  insertRequestSnapshot(snapshot: RequestSnapshot) {
    // A request can end before its route metadata is ever captured - an auth
    // guard rejecting it, a CORS preflight, or a GraphQL document that never
    // reaches a resolver (`{ __typename }`) - leaving no operation id. The
    // collector requires one on every snapshot and rejects the *entire batch*
    // over a single miss, so fall back to the transport's URL, and drop the
    // snapshot when even that is absent rather than poison the batch it would
    // ride in. The URL is folded to a route-like path first, or every query
    // string and id would be a route of its own; `originalUrl` keeps it whole.
    snapshot.operationId ??= fallbackOperationId(
      snapshot.attributes?.originalUrl,
    );
    // A full grant exports ahead of everything below that can leave the
    // snapshot out: the collector's limits and its answers about this
    // account decide what reaches Observe, not what an OTLP receiver of the
    // application's own is sent. The raw snapshot, which the encoder below
    // only copies. A capped grant exports what the batch keeps, further down.
    const otlpExport = this.otlpExportGrant();
    if (otlpExport === "full") {
      this.otlpTraceExporter?.exportRequestSnapshot(snapshot);
    }
    if (!snapshot.operationId) {
      if (this.options.debug) {
        this.logger.debug(
          `Snapshot for traceId "${snapshot.traceId}" has no operation id nor URL to fall back on. Ignoring snapshot.`,
        );
      }
      return;
    }

    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }

    const maxPerBatch = this.maxOperationsPerBatch;
    if (
      this._mainThreadBuffer.snapshots.length + this.withheldSnapshots >=
      maxPerBatch
    ) {
      if (this.options.debug) {
        this.logger.debug(
          `Max snapshots per transaction reached: ${maxPerBatch}. Ignoring snapshot.`,
        );
      }
      return;
    }

    const encodedSnapshot: EncodedRequestSnapshot =
      RequestSnapshotEncoder.encode(snapshot);
    if (this.isErrorsOnly()) {
      // Decided ahead of the rule below, which keeps more than a paused
      // account does: a slow success is notable, and not a server error.
      // Sent or not, the request still brings its handler's objectives due
      // further down - they are not telemetry.
      if (this.sendsWhileErrorsOnly(encodedSnapshot)) {
        this._mainThreadBuffer.snapshots.push(encodedSnapshot);
        if (otlpExport === "capped") {
          // Sent, and never with its tree.
          this.otlpTraceExporter?.exportRequestSnapshot(snapshot, false);
        }
      } else {
        this.withheldSnapshots += 1;
      }
    } else {
      let keepsTree = true;
      if (this.isDegraded() && !isNotableSnapshot(encodedSnapshot)) {
        // The collector is discarding these on arrival; shipping them costs
        // the application its own CPU and bandwidth for nothing. The snapshot
        // still goes - the request, its duration and its error are what the
        // charts are built from, and those are still being kept - and the
        // count goes with it, because it is the only record these existed.
        this.countTruncated(encodedSnapshot.t);
        encodedSnapshot.t = [];
        keepsTree = false;
      }
      this._mainThreadBuffer.snapshots.push(encodedSnapshot);
      if (otlpExport === "capped") {
        this.otlpTraceExporter?.exportRequestSnapshot(snapshot, keepsTree);
      }
    }

    // Read off the raw snapshot: the handler's span carries `Class.method`,
    // which is what `@Objective` declarations are keyed by. Declarations are
    // not telemetry, so they ride even a degraded batch - but a batch holds
    // only as many as the collector accepts, and one that did not fit is left
    // for a later request to bring due.
    const objectives = (this._mainThreadBuffer.objectives ??= []);
    if (objectives.length < MAX_OBJECTIVES_PER_BATCH) {
      const declaration = this.objectivesRegistry?.declarationFor(snapshot);
      if (declaration) {
        objectives.push(declaration);
      }
    }
    if (objectives.length === 0) {
      delete this._mainThreadBuffer.objectives;
    }
  }

  insertJobSnapshot(jobSnapshot: JobSnapshot) {
    // A full grant exports before the cap below, as for a request; a capped
    // one what the batch keeps.
    const otlpExport = this.otlpExportGrant();
    if (otlpExport === "full") {
      this.otlpTraceExporter?.exportJobSnapshot(jobSnapshot);
    }
    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }
    if (!this._mainThreadBuffer.jobs) {
      this._mainThreadBuffer.jobs = [];
    }

    // Same cap as request snapshots, for the same reason: the buffer only
    // empties when a flush succeeds, so without a ceiling a stalled flush on
    // the worker service - the process that sees every queue job - grows this
    // array for as long as the stall lasts.
    const maxPerBatch = this.maxOperationsPerBatch;
    if (this._mainThreadBuffer.jobs.length + this.withheldJobs >= maxPerBatch) {
      if (this.options.debug) {
        this.logger.debug(
          `Max job snapshots per transaction reached: ${maxPerBatch}. Ignoring snapshot.`,
        );
      }
      return;
    }

    const encodedJobSnapshot: EncodedJobSnapshot =
      JobSnapshotEncoder.encode(jobSnapshot);
    if (this.isErrorsOnly()) {
      // A job carries no status code, so the error it failed with is what
      // makes it a server error - which is what the collector keeps of it too.
      if (this.sendsWhileErrorsOnly(encodedJobSnapshot)) {
        this._mainThreadBuffer.jobs.push(encodedJobSnapshot);
        if (otlpExport === "capped") {
          this.otlpTraceExporter?.exportJobSnapshot(jobSnapshot, false);
        }
      } else {
        this.withheldJobs += 1;
      }
    } else {
      let keepsTree = true;
      if (this.isDegraded() && !isNotableSnapshot(encodedJobSnapshot)) {
        // A job carries no status code, so the same rule grades it on its
        // error and its duration - which is what the collector does with it
        // too.
        this.countTruncated(encodedJobSnapshot.t);
        encodedJobSnapshot.t = [];
        keepsTree = false;
      }
      this._mainThreadBuffer.jobs.push(encodedJobSnapshot);
      if (otlpExport === "capped") {
        this.otlpTraceExporter?.exportJobSnapshot(jobSnapshot, keepsTree);
      }
    }
  }

  /**
   * Until when the collector's last answer says spans are being discarded.
   *
   * Zero means "not degraded", which is also where a fresh process starts:
   * the state is learned from a reply, so the first batch after start-up
   * always carries its spans. One batch of wasted trees is the price of not
   * persisting a guess across restarts.
   */
  private degradedUntil = 0;

  /**
   * Whether that answer was errors-only: the account's overage is paused, and
   * only its server errors are kept. It holds as long as the window above and
   * not a moment longer.
   */
  private errorsOnly = false;

  /**
   * How far this app's reporting to NestJS Observe has got - see
   * `isReporting` and `isIngesting`. `off` until the worker starts with the
   * application, `started` from then until the collector accepts a batch,
   * and `ingesting` from that batch on. Refused credentials and a stopped
   * worker set it back to `off`, and only an accepted batch moves it on
   * from there.
   */
  private reporting: "off" | "started" | "ingesting" = "off";

  /**
   * Requests and jobs that errors-only ingest withheld from the batch being
   * built, cleared with it.
   *
   * Counted against `maxTracesPerBatch` as though they had been sent, so a
   * pause grades the same executions a batch would carry outside one: what
   * is reported withheld is what the collector would have been sent and
   * billed, and a busy service encodes no more per batch than it does
   * outside a pause. A server error past the cap is lost, as it would be.
   */
  private withheldSnapshots = 0;
  private withheldJobs = 0;

  /**
   * Records what the collector said about the last batch.
   *
   * Refreshed on every reply rather than latched, so the window slides while
   * the account stays over its allowance and lapses on its own once it does
   * not - the collector has no way to announce the end of it, and an upgrade
   * must not need a restart to take effect.
   *
   * Each reply replaces the last whole: one that is not errors-only ends
   * errors-only ingest at once, whatever it says instead.
   */
  setIngestMode(mode: IngestMode) {
    this.degradedUntil = mode === "full" ? 0 : Date.now() + DEGRADED_TTL_MS;
    this.errorsOnly = mode === "errors-only";
  }

  /**
   * Whether trees the collector discards are being withheld: in every mode
   * but `full`, until the window lapses.
   */
  isDegraded(): boolean {
    return this.degradedUntil > Date.now();
  }

  /** Whether only server errors are being sent, until the same window lapses. */
  isErrorsOnly(): boolean {
    return this.errorsOnly && this.isDegraded();
  }

  /**
   * Whether this app reports to NestJS Observe, as far as the agent can tell:
   * from start-up, once its worker is running, until the collector refuses
   * the app's credentials or the worker stops - and again from the next batch
   * the collector accepts.
   *
   * Nothing has to get in first. A service's first requests are when a new
   * instance joins the traces around it, and an agent set up to report -
   * enabled, with credentials - almost always does. Credentials the collector
   * refuses are learned from the first batch the worker sends, a flush
   * interval into the app's traffic; until then they count as reporting.
   *
   * A batch that fails to get in for any other reason - a collector that is
   * down or slow to answer, a 5xx, a 429 pause, however long - leaves it as
   * it is: that is an outage at NestJS Observe, and the traces running through
   * the services around this one must not break over it. Refused credentials
   * are a verdict on this app, and a stopped worker sends nothing until a new
   * one gets a batch in.
   *
   * OpenTelemetry interop runs on it (see `openTelemetry`): the agent reads
   * and sends `traceparent`, and follows an OpenTelemetry SDK in the process,
   * only beside reporting to NestJS Observe. So an agent that sends Observe
   * nothing - `enabled: false`, no credentials - never turns it on.
   */
  isReporting(): boolean {
    return this.reporting !== "off";
  }

  /**
   * Whether the collector takes this app's telemetry: from the first batch
   * it accepts, until it refuses the app's credentials or the worker stops -
   * and again from the next batch it accepts. What its replies grant, an
   * OTLP export say, holds only while it does.
   */
  isIngesting(): boolean {
    return this.reporting === "ingesting";
  }

  /**
   * The worker started with the application, set up to report: see
   * `isReporting`. A worker restarted after a stop is not this - it has to
   * get a batch in first - and a batch already taken stays taken.
   */
  recordStarted(): void {
    if (this.reporting === "off") {
      this.reporting = "started";
    }
  }

  /** The collector accepted a batch, whatever it then kept of it. */
  recordAccepted(): void {
    this.reporting = "ingesting";
  }

  /** The collector refused the app's credentials. */
  recordRefused(): void {
    this.reporting = "off";
  }

  /** The worker stopped; a restarted one has to get a batch in again. */
  recordStopped(): void {
    this.reporting = "off";
  }

  /**
   * What the collector's last accepted reply granted `otlp` - see
   * `OtlpExportGrant`. Nothing until one says otherwise: what this agent may
   * export is the collector's to say, for the plan the app's account is on.
   */
  private otlpExport: OtlpExportGrant = "off";

  /**
   * Until when a `capped` grant holds (epoch ms), refreshed by every reply
   * that repeats it.
   *
   * A capped export is what NestJS Observe keeps, and the agent learns what
   * that is only from replies. With none coming - an account the collector
   * refuses at its limit, an outage - it would fall back on exporting every
   * span once `isDegraded` lapsed. So the grant lapses first: it is set just
   * before the verdict for the same reply, on the same TTL. A `full` grant
   * holds until a reply says otherwise, and export then runs for as long as
   * `isIngesting` does.
   */
  private otlpExportCappedUntil = 0;

  /** Records what the collector's last accepted reply granted `otlp`. */
  setOtlpExport(grant: OtlpExportGrant, now = Date.now()): void {
    this.otlpExport = grant;
    this.otlpExportCappedUntil = grant === "capped" ? now + DEGRADED_TTL_MS : 0;
  }

  /**
   * What `otlp` may export right now: the collector's grant, while the
   * collector takes this app's telemetry (`isIngesting`) - export runs beside
   * reporting to NestJS Observe, never instead of it - and `off` otherwise.
   * Asked once per operation, as it is handed over.
   */
  otlpExportGrant(now = Date.now()): OtlpExportGrant {
    if (!this.otlpTraceExporter?.enabled || !this.isIngesting()) {
      return "off";
    }
    if (this.otlpExport === "capped" && now >= this.otlpExportCappedUntil) {
      return "off";
    }
    return this.otlpExport;
  }

  /**
   * What errors-only ingest makes of one execution: whether it is sent.
   *
   * Its tree never is, server error or not - the collector stores no tree of
   * a paused account's, and a 5xx storm would otherwise ship every failure's
   * whole waterfall - so its nodes are counted and the array emptied, as
   * degraded ingest empties it. One that is not a server error is not sent at
   * all, and counts itself and the error it carried on top: the same events,
   * in the same units, as the collector counts when it filters a batch itself.
   */
  private sendsWhileErrorsOnly(
    execution: EncodedRequestSnapshot | EncodedJobSnapshot,
  ): boolean {
    this.countTruncated(execution.t);
    execution.t = [];
    if (isServerErrorSnapshot(execution)) {
      return true;
    }
    this.countWithheld(execution.e ? 2 : 1);
    return false;
  }

  /**
   * Adds a withheld tree to the batch's reported truncation.
   *
   * Every node, not every root: the collector meters a trace by its node
   * count, so a number that counted roots would under-report by the shape of
   * the tree and the account would be measured against a fraction of what it
   * actually produced.
   */
  private countTruncated(traces: unknown) {
    this.countWithheld(countTraceNodes(traces));
  }

  /** Adds withheld events, in billed units, to the batch's `truncatedSpans`. */
  private countWithheld(events: number) {
    if (!this._mainThreadBuffer) {
      return;
    }
    this._mainThreadBuffer.truncatedSpans =
      (this._mainThreadBuffer.truncatedSpans ?? 0) + events;
  }

  /**
   * Takes the log records out of the outgoing batch while errors-only ingest
   * holds, one withheld event each - error-level records too: a crash loop
   * logs faster than it fails requests.
   *
   * Done as the batch is written rather than as lines arrive, so a batch
   * counts exactly the records it would have carried - its share of the
   * per-batch cap and of the backlog, as outside a pause - which is what the
   * collector counts when it drops a batch's logs itself. Counted at the door,
   * a chatty service would report lines the cap was always going to drop.
   */
  private withholdLogs() {
    const batch = this._mainThreadBuffer;
    if (!batch?.logs || !this.isErrorsOnly()) {
      return;
    }
    if (batch.logs.length > 0) {
      this.countWithheld(batch.logs.length);
    }
    delete batch.logs;
  }

  /**
   * `maxTracesPerBatch`, held to the most the collector accepts in one section
   * of a batch. It refuses a batch holding more whole, so a setting above that
   * would cost a busy window every operation in it rather than the overflow.
   */
  private get maxOperationsPerBatch(): number {
    return Math.min(
      this.options.maxTracesPerBatch ?? DEFAULT_MAX_SNAPSHOTS_PER_TRANSACTION,
      MAX_BATCH_ITEMS,
    );
  }

  isBufferLocked() {
    return Atomics.load(this.lock, 0) !== 0;
  }

  isBufferEmpty() {
    return !this._mainThreadBuffer;
  }

  /** Whether log lines are held back for a later batch. */
  hasPendingLogs() {
    return this._pendingLogs.length > 0;
  }

  /** Whether the outgoing batch already carries a runtime-metrics sample. */
  hasRuntimeMetrics() {
    return this._mainThreadBuffer?.runtime !== undefined;
  }

  /**
   * Whether a batch written by `encodeAndWrite` is still in the shared slot -
   * not yet taken by the worker, or taken and still being sent.
   *
   * Once the worker takes the slot it holds the lock until the collector has
   * answered (or the send has failed), and zeroes the length just before it
   * lets go, on every path. So a non-zero length means the worker is not done
   * with the last batch, which is what a shutdown waits on before writing
   * another one or terminating the thread - unless the worker has said it is
   * paused (`PAUSED_MESSAGE_PREFIX`), in which case it leaves the slot alone.
   * Read without the lock: a stale answer only costs the caller one more look.
   */
  hasBatchAwaitingWorker() {
    return new DataView(this._sharedBuffer, 4, 4).getUint32(0) !== 0;
  }

  /**
   * Takes the lock, or reports that someone else holds it.
   *
   * One `compareExchange` rather than a read followed by a write: the worker
   * thread contends for this same word, so between a `load` saying the lock was
   * free and a `store` taking it, the worker can take it too - and both sides
   * then believe they hold it, one writing the buffer while the other reads it.
   * `compareExchange` only stores if the word is still what we read, and
   * returns what was there, so "it was free and it is now ours" is a single
   * indivisible step.
   */
  acquireLock() {
    if (Atomics.compareExchange(this.lock, 0, 0, 1) !== 0) {
      return false;
    }

    if (this.options.debug) {
      this.logger.debug("Shared buffer lock acquired.");
    }
    return true;
  }

  releaseLock() {
    Atomics.store(this.lock, 0, 0);
    Atomics.notify(this.lock, 0); // Notify any waiting threads

    if (this.options.debug) {
      this.logger.debug("Shared buffer lock released.");
    }
  }

  addNodeRuntimeMetrics(runtimeMetrics: NodeRuntimeMetrics | undefined) {
    if (!runtimeMetrics) {
      return;
    }
    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }
    this._mainThreadBuffer.runtime =
      RuntimeMetricsEncoder.encode(runtimeMetrics);
  }

  upsertCustomMetric(metric: Counter<any> | Gauge<any> | Summary<any>) {
    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }

    if (!this._mainThreadBuffer.custom) {
      this._mainThreadBuffer.custom = [];
    }

    if (metric instanceof Counter || metric instanceof Summary) {
      this._awaitingFlushAck.add(metric);
    }

    // Encoded when the batch is written, not on every change: a metric is
    // changed on the request path, and encoding one reads all of it - a
    // summary sorts its sample once per quantile, a counter or gauge at its
    // series cap copies a thousand series - so encoding on every change cost
    // the main thread more the fuller the window got, for an entry the next
    // change replaced.
    this._metricsToEncode.add(metric);
  }

  private placeCustomMetric(metric: Counter<any> | Gauge<any> | Summary<any>) {
    const custom = this._mainThreadBuffer?.custom;
    if (!custom) {
      return;
    }

    // Matched on the name as sent, which the encoder cuts to what the
    // collector accepts. Matched on the metric's own, a metric whose name is
    // cut would be buffered again on every change.
    const encoded = CustomMetricsEncoder.encode(metric as CustomMetric);
    const existingMetricIndex = custom.findIndex(
      (m) => m.n === encoded.n && m.t === encoded.t,
    );
    if (existingMetricIndex !== -1) {
      custom[existingMetricIndex] = {
        ...custom[existingMetricIndex],
        ...encoded,
      };
    } else {
      custom.push(encoded);
    }
  }

  /** Once for the process: the same metric fails the same way every window. */
  private reportUnencodableMetric(
    metric: Counter<any> | Gauge<any> | Summary<any>,
    error: unknown,
  ): void {
    if (this.hasReportedUnencodableMetric) {
      return;
    }
    this.hasReportedUnencodableMetric = true;
    let reason: string;
    try {
      reason = error instanceof Error ? error.message : String(error);
    } catch {
      reason = "an unprintable error";
    }
    // Typed as a string, and as unchecked at run time as what failed.
    const name: unknown = metric.name;
    this.logger.warn(
      `Custom metric "${typeof name === "string" ? name.slice(0, 100) : typeof name}" could not be encoded and is left out of the batch. Later metrics that cannot be encoded are not reported: ${reason}`,
    );
  }

  /**
   * Buffers log entries, filling the current batch first and holding the rest
   * back for later batches. Oversized lines are truncated on the way in.
   *
   * The overflow is deferred rather than discarded: a burst that exceeds one
   * batch is the most interesting thing the logs will ever carry. Only once
   * the backlog is also full does anything get lost.
   *
   * When both are full the *newest* lines are dropped. During a burst the
   * opening lines are usually the ones that explain it; losing the tail of a
   * retry storm costs less than losing its first cause.
   *
   * Unlike the other insert methods this one stays silent when it drops. It is
   * called from the patched `process.stdout.write`, so a debug line here would
   * write to stdout, re-enter `pushLogs`, drop again, and log again - the cap
   * would turn every dropped entry into unbounded recursion.
   */
  pushLogs(logs: Array<BufferedLogEntry>) {
    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }
    if (!this._mainThreadBuffer.logs) {
      this._mainThreadBuffer.logs = [];
    }

    const buffered = this._mainThreadBuffer.logs;
    for (const log of logs) {
      // The `typeof` guard is not redundant with the type: entries arrive from
      // a patched `process.stdout.write`, where a caller passing something
      // unexpected must not crash the host - flush-time sanitization drops the
      // malformed entry instead.
      const entry =
        typeof log.text === "string" && log.text.length > MAX_LOG_ENTRY_LENGTH
          ? { ...log, text: this.truncateLogText(log.text) }
          : log;

      if (buffered.length < MAX_LOGS_PER_TRANSACTION) {
        buffered.push(entry);
        continue;
      }
      if (this._pendingLogs.length < MAX_PENDING_LOGS) {
        this._pendingLogs.push(entry);
        continue;
      }
      return;
    }
  }

  /**
   * Tops the outgoing batch up from the backlog.
   *
   * Called by the worker immediately before it decides whether there is
   * anything worth flushing - which is what stops a backlog stranding itself. A
   * burst leaves lines pending, the process then goes quiet, and with nothing
   * new arriving `pushLogs` would never run again to move them; the buffer
   * would read as empty and those lines would sit there until shutdown.
   *
   * Drained lines are appended after whatever the batch already holds, so a
   * batch is not ordered by time. Nothing downstream depends on that: every
   * entry carries its own timestamp, the recorder inserts by it, and the log
   * views sort on it.
   *
   * `maxLogs` lifts the per-batch cap for the final flush, which sends the
   * whole backlog in one batch rather than one round trip per 250 lines.
   */
  drainPendingLogs(maxLogs = MAX_LOGS_PER_TRANSACTION) {
    if (this._pendingLogs.length === 0) {
      return;
    }

    if (!this._mainThreadBuffer) {
      this._mainThreadBuffer = this.createEmptyPayload();
    }
    if (!this._mainThreadBuffer.logs) {
      this._mainThreadBuffer.logs = [];
    }

    const capacity = maxLogs - this._mainThreadBuffer.logs.length;
    if (capacity <= 0) {
      return;
    }
    this._mainThreadBuffer.logs.push(
      ...this._pendingLogs.splice(0, Math.min(capacity, MAX_PENDING_LOGS)),
    );
  }

  private truncateLogText(text: string): string {
    return (
      text.slice(0, MAX_LOG_ENTRY_LENGTH - TRUNCATION_SUFFIX.length) +
      TRUNCATION_SUFFIX
    );
  }

  encodeAndWrite() {
    this.withholdLogs();

    for (const metric of this._metricsToEncode) {
      try {
        this.placeCustomMetric(metric);
      } catch (error) {
        // One metric the encoder cannot read - a label name that is not a
        // string at run time - is left out rather than costing the batch,
        // and is not marked as delivered.
        if (metric instanceof Counter || metric instanceof Summary) {
          this._awaitingFlushAck.delete(metric);
        }
        this.reportUnencodableMetric(metric, error);
      }
    }
    this._metricsToEncode.clear();

    if (this.options.debug) {
      if (this._mainThreadBuffer?.snapshots) {
        this.logger.debug(
          `Encoding and writing ${this._mainThreadBuffer.snapshots.length} snapshots to shared buffer.`,
        );
        this.logger.debug(
          `Operations in shared buffer: ${this._mainThreadBuffer.snapshots.map(
            (s) => s.op,
          )}`,
        );
      }
    }

    const jsonBytes = this.encodeToFit();
    const jsonLength = jsonBytes.length;

    // Offset 4 for the lock value
    const view = new DataView(this._sharedBuffer, 4, 4);

    // Store the length of the JSON data
    view.setUint32(0, jsonLength);

    // Copy the JSON bytes into the shared buffer
    this.sharedBytes.set(jsonBytes, 8);

    // Only now is the payload genuinely handed off, so this is the point at
    // which a counter's reported increase, or a summary's window of
    // observations, can be considered delivered. Doing it any earlier (or in the
    // caller's finally block, which also runs when the write throws) would
    // silently drop a window's worth of measurements.
    for (const metric of this._awaitingFlushAck) {
      metric.markFlushed();
    }
    this._awaitingFlushAck.clear();
  }

  /**
   * The batch as the bytes written to the shared slot, which they have to fit.
   *
   * `maxTracesPerBatch` bounds how many operations a batch holds, not how
   * large each is, and parts of one are as long as a client made them - a
   * URL, the text of an error. One entry can also hold what `JSON.stringify`
   * refuses: a tag of a type nothing checked at run time. Either way the whole
   * batch was thrown away, with every other request, job, log line and metric
   * of the window. Such a batch is now sent without the entries that keep it
   * from being written, so they cost only themselves.
   *
   * A batch that fits is serialised once, as before; only one that does not
   * has its entries measured.
   */
  private encodeToFit(): Uint8Array {
    // 8 bytes reserved for the lock and length
    const capacity = SHARED_BUFFER_SIZE - 8;
    const whole = this.encodeWithin(capacity);
    if (whole instanceof Uint8Array) {
      return whole;
    }

    const dropped = this.dropEntriesToFit(capacity);
    const fitted = this.encodeWithin(capacity);
    if (!(fitted instanceof Uint8Array)) {
      // What is left is in a section no entry can be taken out of.
      throw fitted ?? new Error("Payload too large for shared buffer");
    }
    this.logger.warn(
      `A telemetry batch could not be written whole - it came to more than the ${capacity} bytes one flush carries, or held a value that cannot be serialised - and was sent without ${dropped} of its entries: any that cannot be serialised, then the largest.`,
    );
    return fitted;
  }

  /**
   * The batch as bytes; nothing when it comes to more than `capacity`, and
   * what `JSON.stringify` threw when it cannot be serialised at all.
   */
  private encodeWithin(capacity: number): Uint8Array | Error | undefined {
    let json: string;
    try {
      json = JSON.stringify(this._mainThreadBuffer);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    // Each character is a byte at least, so a longer one is known not to fit.
    if (json.length > capacity) {
      return undefined;
    }
    const bytes = this.encoder.encode(json);
    return bytes.length > capacity ? undefined : bytes;
  }

  /**
   * Takes request snapshots, job snapshots and log entries out of the batch -
   * any that cannot be serialised, then the largest - until what is left
   * comes to at most `capacity` bytes, and returns how many went. Metrics are
   * left in: a metric's window closes once the batch is written, so one taken
   * out here would be lost rather than carried to the next.
   */
  private dropEntriesToFit(capacity: number): number {
    const batch = this._mainThreadBuffer;
    if (!batch) {
      return 0;
    }

    const dropped = new Set<unknown>();
    const sized: Array<{ entry: unknown; bytes: number }> = [];
    for (const entry of [
      ...batch.snapshots,
      ...(batch.jobs ?? []),
      ...(batch.logs ?? []),
    ]) {
      try {
        // One more for the comma that follows it.
        sized.push({
          entry,
          bytes: Buffer.byteLength(JSON.stringify(entry)) + 1,
        });
      } catch {
        dropped.add(entry);
      }
    }
    sized.sort((a, b) => b.bytes - a.bytes);

    let total = 0;
    try {
      total = Buffer.byteLength(
        JSON.stringify({ ...batch, snapshots: [], jobs: [], logs: [] }),
      );
    } catch {
      // Left to the encode that follows, which reports it.
    }
    for (const { bytes } of sized) {
      total += bytes;
    }
    for (const { entry, bytes } of sized) {
      if (total <= capacity) {
        break;
      }
      dropped.add(entry);
      total -= bytes;
    }

    if (dropped.size > 0) {
      const kept = (entry: unknown) => !dropped.has(entry);
      batch.snapshots = batch.snapshots.filter(kept);
      if (batch.jobs) {
        batch.jobs = batch.jobs.filter(kept);
      }
      if (batch.logs) {
        batch.logs = batch.logs.filter(kept);
      }
    }
    return dropped.size;
  }

  resetMainThreadBuffer() {
    this._mainThreadBuffer = null;
    this._metricsToEncode.clear();
    this.withheldSnapshots = 0;
    this.withheldJobs = 0;
  }

  private createEmptyPayload(): AgentMetricsPayload {
    const payload = {
      serviceId: this.options.serviceId,
      snapshots: [],
      forwardLogs: Boolean(this.options.forwardLogs),
    } as AgentMetricsPayload;

    if (this.options.serviceVersion) {
      payload.serviceVersion = this.options.serviceVersion;
    }

    return payload;
  }
}
