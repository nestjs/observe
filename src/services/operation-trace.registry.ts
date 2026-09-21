import { IntrinsicException, Logger, RequestMethod } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { activeSliceRecorder } from "../profiling/span-slice-recorder.js";
import { uuidv7 } from "../utils/uuid-v7.util.js";
import { JobSnapshot } from "../interfaces/index.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { CreateObserveModuleOptions } from "../interfaces/observe-options.interface.js";
import {
  CompleteTraceEventNode,
  OngoingTraceEventNode,
} from "../interfaces/trace-events.interfaces.js";
import { TraceSpanDelegate } from "../trace-span.delegate.js";
import { KeyOf } from "../types/key-of.type.js";
import { CodeFrame, collectCodeFrames } from "../utils/source-context.util.js";
import { LogRedactor } from "../utils/log-redactor.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";
import {
  collapseRepeatedSpans,
  DEFAULT_SPAN_COLLAPSE,
  SpanCollapseSettings,
} from "./collapse-repeated-spans.util.js";

const SNAPSHOT_COMPLETION_TIMEOUT_MS = 1000;

type TraceId = string;
type SnapshotWithSignal = (RequestSnapshot | JobSnapshot) & {
  /**
   * Internal counter to track references to this snapshot.
   */
  refsCounter: number;
  /**
   * Used to determine when the snapshot is complete.
   * When `refsCounter` equals `refsMarkedAsComplete`, the snapshot is complete.
   */
  refsMarkedAsComplete: number;
  /**
   * Status code stood in for a root span that threw, on protocols that carry no
   * status code of their own (RPC, gRPC). Without one the backend counts the
   * failure as neither handled nor unhandled - its aggregates bucket by status
   * code alone - so a failing message pattern reports zero errors of either
   * kind.
   */
  errorStatusCode?: number;
};

/**
 * An error the business logic did not model. `IntrinsicException` is what Nest
 * itself uses to tell a deliberately raised failure from a leaked one.
 */
const UNHANDLED_ERROR_STATUS_CODE = 500;

/**
 * A failure the handler raised on purpose. 4xx is what the backend's aggregates
 * count as handled; the exact code only matters when the exception carries one.
 */
const HANDLED_ERROR_STATUS_CODE = 400;

export class OperationTraceRegistry {
  private readonly traceSnapshots: Map<TraceId, SnapshotWithSignal> = new Map();
  // Keyed by `string | undefined` because a root span has no caller: entries
  // are only ever stored under a real span id, but the lookup domain includes
  // "no caller", which is a legitimate miss rather than a type error.
  private readonly callerIdsByTraceId: Map<
    TraceId,
    Map<string | undefined, OngoingTraceEventNode>
  > = new Map();
  private readonly logger = new Logger(OperationTraceRegistry.name);
  /**
   * An application started without `instrument` fails this way on *every*
   * request, and the guidance below is long enough that repeating it verbatim
   * would bury everything else in the log. Full text once, one line after.
   */
  private hasReportedMissingInstrumentation = false;
  /**
   * Applied to every tree as it is plucked. Defaults are live from
   * construction rather than waiting for `configureSpanCollapse`, so a
   * registry the module has not (yet) configured still bounds what it ships.
   */
  private spanCollapse: SpanCollapseSettings | undefined =
    DEFAULT_SPAN_COLLAPSE;
  /**
   * Scrubs error messages and stacks before they are attached to a span.
   *
   * On by default, with the same defaults the log forwarder uses, for the
   * same reason: an error is at least as likely a carrier of a secret as a
   * log line - a driver error quoting a DSN with the password in it, a fetch
   * failure quoting a URL with a token in it - and an error payload is shipped
   * whether or not log forwarding is on. Null only when redaction has been
   * switched off explicitly.
   */
  private redactor: LogRedactor | null = new LogRedactor();

  constructor(
    private readonly als: AsyncLocalStorage<
      Map<KeyOf<{ [CALLER_METADATA_KEY]: string }>, unknown>
    >,
    private readonly sourceContext: CreateObserveModuleOptions["sourceContext"] = true,
  ) {}

  /**
   * Sets how repeated siblings are collapsed on the way out, or switches it
   * off with `undefined`. Called by the module once `ObserveOptions` have
   * resolved, which is after this instance exists: the registry is built
   * before the DI container so the instrumentation hook can hold it.
   */
  configureSpanCollapse(settings: SpanCollapseSettings | undefined): void {
    this.spanCollapse = settings;
  }

  /**
   * Applies the resolved `redaction` options to error payloads, or switches
   * redaction off with `null`. Called by the module alongside
   * `configureSpanCollapse`, for the same reason.
   */
  configureRedaction(redactor: LogRedactor | null): void {
    this.redactor = redactor;
  }

  /**
   * The redactor error payloads go through, for a caller adding to one - so
   * what it adds is held to the same rules as the rest of the payload.
   */
  getRedactor(): LogRedactor | null {
    return this.redactor;
  }

  /**
   * Builds the error payload attached to a span or snapshot, including the source
   * around each in-app frame when source context is enabled.
   */
  private toErrorPayload(error: Error | string | object) {
    const raw =
      error instanceof Error
        ? { message: error.message, stack: error.stack }
        : { message: String(error), stack: undefined };
    // Redacted here, at the one point every error payload passes through.
    const payload = this.redactor
      ? {
          message: this.redactor.redactMessage(raw.message),
          stack:
            raw.stack === undefined
              ? undefined
              : this.redactor.redactMessage(raw.stack),
        }
      : raw;

    const result: {
      cls?: string;
      message: string;
      stack?: string;
      codeFrames?: CodeFrame[];
      tags?: Record<string, string | number | boolean>;
    } = payload;

    if (typeof error?.constructor === "function") {
      result.cls = error.constructor.name;
    }

    if (this.sourceContext !== false) {
      const settings = this.sourceContext === true ? {} : this.sourceContext;
      // Read off the raw stack with the raw message: the message is what marks
      // where the frames start, and it only matches the stack it came from.
      // Nothing of either is shipped from here - just the file positions.
      const codeFrames = collectCodeFrames(raw.stack, {
        ...settings,
        message: raw.message,
      });
      if (codeFrames) {
        // Source is as likely to hold a literal secret as a message is, and
        // goes to the same place.
        const redactor = this.redactor;
        result.codeFrames = redactor
          ? codeFrames.map((frame) => ({
              ...frame,
              lines: redactor.redactSource(frame.lines),
            }))
          : codeFrames;
      }
    }

    return result;
  }

  /**
   * Whether a trace is open under this key - for a caller about to open one
   * under an id it adopted rather than minted, which a second operation in
   * this process may already hold.
   */
  hasTrace(traceId: TraceId): boolean {
    return this.traceSnapshots.has(traceId);
  }

  startTrace(
    traceId: TraceId,
    data:
      | Omit<
          RequestSnapshot,
          "traces" | "startTimestamp" | "calledAt" | "traceId"
        >
      | Omit<JobSnapshot, "duration">,
    /**
     * The trace id the snapshot reports under, when it is not the registry
     * key - a job inheriting the id of the operation that enqueued it.
     */
    reportedTraceId: string = traceId,
  ): void {
    if (this.traceSnapshots.has(traceId)) {
      this.logger.warn(
        `Trace already started for traceId: "${traceId}". Overwriting existing trace.`,
      );
      this.traceSnapshots.delete(traceId);
      this.callerIdsByTraceId.delete(traceId);
    }

    const snapshot: SnapshotWithSignal = {
      ...data,
      traceId: reportedTraceId,
      calledAt: new Date().toISOString(),
      startTimestamp: performance.now(),
      traces: [],
      refsCounter: 0,
      refsMarkedAsComplete: 0,
    };
    this.traceSnapshots.set(traceId, snapshot);
  }

  endTrace(traceId: string): void;
  endTrace(
    traceId: string,
    opts?: { statusCode?: number; userId?: string },
  ): void;
  endTrace(traceId: string, opts?: { status?: JobSnapshot["status"] }): void;
  endTrace(
    traceId: string,
    opts:
      | { statusCode?: number; userId?: string }
      | { status?: JobSnapshot["status"] } = {},
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      return;
    }

    if (snapshot.traces.length === 0) {
      if ("operationId" in snapshot) {
        // An operationId means a handler ran, and zero traces means nothing
        // recorded a span for it. Both at once has one cause: the instance
        // decorator never wrapped the providers, because `instrument` never
        // reached NestFactory.
        this.reportMissingInstrumentation(snapshot);
        this.traceSnapshots.delete(traceId);
        return;
      }

      // Ignore snapshots that have no traces as that means
      // the request didnt even have a handler in the first place
      this.traceSnapshots.delete(traceId);
      return;
    }
    // Set by `startTrace` and deleted a few lines below, so it is always there
    // for a snapshot still in the registry. The fallback keeps a duration of 0
    // rather than a NaN that would poison every average built over it.
    const startTimestamp = snapshot.startTimestamp ?? performance.now();
    snapshot.duration = performance.now() - startTimestamp;

    const reportedStatusCode =
      "statusCode" in opts && typeof opts.statusCode === "number"
        ? opts.statusCode
        : undefined;
    const errorStatusCode =
      "protocol" in snapshot ? snapshot.errorStatusCode : undefined;

    // A root span that threw outranks a success status code reported by the
    // transport. Two cases need this. Transports that carry no status code of
    // their own (RPC, gRPC) end their trace without one at all, and the backend
    // buckets errors by status code alone - so a failing message pattern would
    // otherwise report zero handled *and* zero unhandled errors. GraphQL is the
    // sharper case: it answers 200 even when the resolver threw, reporting the
    // error in the body, so trusting the transport would give a service with a
    // failing resolver a flat zero error rate. 500 marks the failure as
    // unhandled, 4xx as deliberate.
    const statusCode =
      errorStatusCode !== undefined &&
      (reportedStatusCode === undefined || reportedStatusCode < 400)
        ? errorStatusCode
        : reportedStatusCode;

    if (typeof statusCode === "number") {
      this.setStatusCode(snapshot, statusCode);
    }

    if ("status" in opts && typeof opts.status === "string") {
      const jobSnapshot = snapshot as JobSnapshot;
      jobSnapshot.status = opts.status;
    }

    if ("userId" in opts && typeof opts.userId !== "undefined") {
      const requestSnapshot = snapshot as RequestSnapshot;
      requestSnapshot.userId = String(opts.userId);
    }

    delete snapshot.startTimestamp; // Clean up to avoid confusion

    if (snapshot.traces && snapshot.traces.length > 0) {
      // Iterate through root traces to check if any have errors
      for (const trace of snapshot.traces) {
        if ("error" in trace && trace.error) {
          // If any root trace has an error, we mark the entire snapshot as having an error
          if (typeof trace.error === "object") {
            snapshot.error = trace.error;
          }
          break; // No need to check further once an error is found
        }
      }
    }
  }

  /**
   * Reports a handler that ran without instrumentation. The example is spelled
   * out because the fix is never in the file the developer is looking at: the
   * symptom appears in a controller, the cause is in `main.ts`.
   */
  private reportMissingInstrumentation(snapshot: RequestSnapshot): void {
    const method = snapshot.attributes?.method;
    const operation = method
      ? `${method} ${snapshot.operationId}`
      : snapshot.operationId;

    if (this.hasReportedMissingInstrumentation) {
      this.logger.error(
        `Operation "${operation}" produced no spans - the "instrument" option is still missing from NestFactory (traceId: "${snapshot.traceId}").`,
      );
      return;
    }
    this.hasReportedMissingInstrumentation = true;

    this.logger.error(
      [
        `Operation "${operation}" produced no spans, so this request is missing from your traces (traceId: "${snapshot.traceId}").`,
        `The handler ran, but none of its providers were instrumented - which happens when the "instrument" option never reaches NestFactory.`,
        ``,
        `Pass the instrument that createObserveModule() returns next to the module it belongs to:`,
        ``,
        `  // app.module.ts`,
        `  export const { ObserveModule, ObserveInstrument } = createObserveModule();`,
        ``,
        `  // main.ts`,
        `  const app = await NestFactory.create(AppModule, {`,
        `    instrument: ObserveInstrument,`,
        `  });`,
        ``,
        `NestFactory.createMicroservice() accepts the same option. Later occurrences of this error are logged on a single line.`,
      ].join("\n"),
    );
  }

  /**
   * Classifies a failed operation for transports that report no status code.
   *
   * `IntrinsicException` is the line Nest itself draws between a failure the
   * handler raised on purpose and one that leaked out of it, so it is the line
   * used here: intrinsic errors land in the handled bucket, everything else in
   * the unhandled one. An `HttpException` keeps its own code when that code
   * already reads as handled - a 5xx one would otherwise be counted against the
   * handler that deliberately raised it.
   */
  private toErrorStatusCode(error: Error | string | object): number {
    if (!(error instanceof IntrinsicException)) {
      return UNHANDLED_ERROR_STATUS_CODE;
    }

    const status = (error as { getStatus?: () => unknown }).getStatus?.();
    if (typeof status === "number" && status >= 400 && status < 500) {
      return status;
    }
    return HANDLED_ERROR_STATUS_CODE;
  }

  private setStatusCode(
    snapshot: RequestSnapshot | JobSnapshot,
    statusCode: number,
  ): void {
    const requestSnapshot = snapshot as RequestSnapshot;
    if (!requestSnapshot.attributes) {
      requestSnapshot.attributes = {};
    }
    requestSnapshot.attributes.statusCode = statusCode;
  }

  internalStartTraceStep(
    traceId: TraceId,
    className: string,
    methodKey: string,
    callerId: string | undefined,
  ): string | undefined {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      return undefined;
    }
    snapshot.refsCounter += 1;

    const newNodeId = uuidv7();
    const startTime = performance.now();

    // Records which span owns the thread from here. A no-op unless continuous
    // profiling is on, and the only way profile samples can be attributed to a
    // span: V8 hands back a batch afterwards, so there is nothing to label at
    // the moment a sample fires.
    activeSliceRecorder()?.enter(traceId, newNodeId, startTime);
    const newNode: OngoingTraceEventNode = {
      origin: "auto",
      type: "start",
      className,
      methodKey,
      startTime,
      startOffset: this.toStartOffset(snapshot, startTime),
      children: [],
      // The caller id doubles as the span id rather than a second identifier
      // being minted for it. That is what lets a log line name the span it was
      // written inside: the forwarder reads this exact value out of the async
      // store (CALLER_METADATA_KEY), so the two sides agree by construction
      // instead of by a timing heuristic. It costs a uuid per span on the wire.
      spanId: newNodeId,
    };

    let refsByCaller = this.callerIdsByTraceId.get(traceId);
    this.attachToCaller(snapshot, refsByCaller, callerId, newNode);

    if (!refsByCaller) {
      refsByCaller = new Map<string, OngoingTraceEventNode>();
      this.callerIdsByTraceId.set(traceId, refsByCaller);
    }
    refsByCaller.set(newNodeId, newNode);

    return newNodeId;
  }

  /**
   * Nests a freshly opened node under its caller when that caller is still
   * live, and at the trace root otherwise.
   *
   * A caller that has already completed has had its scratch fields stripped
   * (`type`, and `children` when it had none), so there is nothing left to
   * nest under. That happens whenever a callee outlives its caller - most
   * commonly a handler that Nest bound (`AsyncResource.bind` in its
   * interceptors consumer) to the async context of an interceptor whose
   * `intercept()` returned synchronously. Fall back to the root rather than
   * throw into the request: the mirror case, a step ending after its caller
   * did, is already tolerated in `internalEndTraceStep`. Auto and manual spans
   * both attach through here, so they share the tolerance.
   */
  private attachToCaller(
    snapshot: SnapshotWithSignal,
    refsByCaller: Map<string | undefined, OngoingTraceEventNode> | undefined,
    callerId: string | undefined,
    newNode: OngoingTraceEventNode,
  ): void {
    const caller = callerId ? refsByCaller?.get(callerId) : undefined;
    if (caller?.type === "start") {
      caller.children.push(newNode);
      newNode.parent = caller;
    } else {
      // No (live) caller means insert trace at the root level
      snapshot.traces.push(newNode);
    }
  }

  internalEndTraceStep(
    traceId: TraceId,
    /**
     * Diagnostic label only - it names the span in the two warnings below and
     * is read nowhere else. Absent for a step that never opened, which is the
     * same condition `callerId` reports.
     */
    spanId: string | undefined,
    className: string,
    methodKey: string,
    // Undefined when `internalStartTraceStep` found no snapshot to open the
    // step against; the lookup below then misses and warns, as it does for any
    // other unknown caller.
    callerId: string | undefined,
    error?: Error | string | object,
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      this.logger.error(
        `No snapshot found for traceId: "${traceId}". Cannot end trace step for "${className}#${methodKey}".`,
      );
      return;
    }
    snapshot.refsMarkedAsComplete += 1;
    activeSliceRecorder()?.exit(callerId);

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    if (!refsByCaller) {
      this.logger.warn(
        `No ongoing ref map found for the "${spanId}" span. Some of your async operations were not awaited and the outer span ended before the inner one. Check your "${className}#${methodKey}" method. Ignore if this is the desired behavior.`,
      );
      return;
    }
    const cursor: OngoingTraceEventNode | undefined =
      refsByCaller.get(callerId);
    if (!cursor) {
      this.logger.warn(
        `No ongoing trace found for the "${spanId}" span. Some of your async operations were not awaited and the outer span ended before the inner one. Check your "${className}#${methodKey}" method. Ignore if this is the desired behavior.`,
      );
      return;
    }

    const duration = performance.now() - cursor.startTime;

    // `type`, `startTime` and `parent` are exactly what separates an ongoing
    // node from a complete one, so removing them *is* the conversion the cast
    // below records. They go through a view that admits their absence rather
    // than each needing its own suppression.
    const completing = cursor as Partial<OngoingTraceEventNode>;
    delete completing.type; // The node is now complete
    delete completing.startTime; // The duration is now set
    const parent = cursor.parent;
    delete completing.parent; // Complete nodes carry no parent reference

    // Remove tags if empty
    if (Object.keys(cursor.tags || {}).length === 0) {
      delete completing.tags;
    }

    // Clean up children array if it is empty
    if (cursor.children.length === 0) {
      delete completing.children;
    }

    const activeTrace: CompleteTraceEventNode =
      cursor as unknown as CompleteTraceEventNode;

    activeTrace.duration = duration;

    if (error && !activeTrace.error) {
      const isRootSpan = !parent;
      if (isRootSpan) {
        // Only a root span decides this: an error thrown deeper down may well
        // have been caught and handled by its caller, in which case the
        // operation did not fail at all.
        snapshot.errorStatusCode = this.toErrorStatusCode(error);

        // If this is the root span, we can directly set the error on the snapshot
        // if it's a non-intrinsic error
        if (typeof error === "object") {
          activeTrace.error = this.toErrorPayload(error);
        } else {
          activeTrace.error = true;
        }
      } else {
        activeTrace.error = true;
      }
    }
  }

  addRouteMetadataToTrace(
    requestId: string,
    requestMethod: RequestMethod,
    path: string,
  ): void {
    const snapshot = this.traceSnapshots.get(requestId) as RequestSnapshot;
    if (!snapshot) {
      return;
    }
    snapshot.operationId = path;
  }

  /**
   * Labels a trace with the GraphQL root field being resolved.
   *
   * Only the first root field of a request wins. A document may select several
   * (`{ orders { id } customers { id } }`), and an operation id that changed
   * with the last field to finish would scatter one endpoint's traffic across
   * several rows; first-one-wins is arbitrary but stable. It also means a
   * `/graphql` route label - were one ever set - is not overwritten silently.
   */
  addGraphQLMetadataToTrace(
    traceId: TraceId,
    metadata: {
      operationId: string;
      tags?: Record<string, string | number | boolean>;
      attributes?: RequestSnapshot["attributes"];
    },
  ): void {
    const snapshot = this.traceSnapshots.get(traceId) as RequestSnapshot;
    if (!snapshot) {
      return;
    }
    snapshot.operationId ??= metadata.operationId;
    if (metadata.tags) {
      snapshot.tags = { ...snapshot.tags, ...metadata.tags };
    }
    if (metadata.attributes) {
      // Merged over whatever the transport recorded. Method and status code
      // survive; `originalUrl` is deliberately replaced - the GraphQL document
      // is the informative value, the shared mount path is not.
      snapshot.attributes = { ...snapshot.attributes, ...metadata.attributes };
    }
  }

  /**
   * Offset of a span's start from the start of its trace root, in milliseconds.
   *
   * Captured when the span opens rather than when it closes: `startTimestamp` is
   * deleted once the trace ends, and a span that outlives its trace (an un-awaited
   * async call) would otherwise lose its offset entirely.
   */
  private toStartOffset(
    snapshot: SnapshotWithSignal | undefined,
    startTime: number,
  ): number | undefined {
    if (typeof snapshot?.startTimestamp !== "number") {
      return undefined;
    }
    return startTime - snapshot.startTimestamp;
  }

  captureError(
    traceId: string,
    callerId: string | undefined,
    error: Error | string,
    tags: Record<string, string | number | boolean>,
  ): void {
    const snapshot = this.traceSnapshots.get(traceId);
    if (!snapshot) {
      this.logger.warn(
        `No request snapshot found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    if (!snapshot.traces || snapshot.traces.length === 0) {
      this.logger.warn(
        `No traces found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    const targetSpan = refsByCaller?.get(callerId);
    if (!targetSpan) {
      this.logger.warn(
        `No active span found for traceId: "${traceId}". Cannot capture error.`,
      );
      return;
    }

    if (!targetSpan.tags) {
      targetSpan.tags = {};
    }

    // Merge tags
    Object.assign(targetSpan.tags, tags);

    targetSpan.error = this.toErrorPayload(error);
  }

  /**
   * Drops a trace that will never be plucked, freeing both maps.
   *
   * The HTTP agent calls this when a client aborts: the adapter's response
   * hook rides `finish`, which an aborted response never emits, so without
   * this the snapshot - spans, error payloads, code frames - would stay
   * registered for the life of the process. Nothing is reported; a trace with
   * no response has no status code to file it under.
   */
  abandonTrace(traceId: TraceId): void {
    this.callerIdsByTraceId.delete(traceId);
    this.traceSnapshots.delete(traceId);
  }

  async pluckSnapshot(
    traceId: string,
  ): Promise<RequestSnapshot | JobSnapshot | undefined> {
    const snapshot = this.traceSnapshots.get(traceId);
    if (snapshot) {
      const cleanup = () => {
        this.callerIdsByTraceId.delete(traceId);
        this.traceSnapshots.delete(traceId);
      };

      // Ensure snapshot is complete by checking refsCounter vs refsMarkedAsComplete
      if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
        await new Promise((resolve) =>
          setTimeout(resolve, SNAPSHOT_COMPLETION_TIMEOUT_MS),
        );
        if (snapshot.refsCounter > snapshot.refsMarkedAsComplete) {
          cleanup();
          return undefined;
        }
      }
      cleanup();

      // These three are what distinguish the registry's working copy from the
      // snapshot the API receives, so removing them is the hand-off.
      const bookkeeping = snapshot as Partial<SnapshotWithSignal>;
      delete bookkeeping.refsCounter;
      delete bookkeeping.refsMarkedAsComplete;
      delete bookkeeping.errorStatusCode;

      // Last, on the finished tree: every span has closed by now, so a group
      // is judged on its complete membership and durations, and nothing that
      // reads the tree afterwards - the encoder, the buffer - sees the
      // uncollapsed one.
      if (this.spanCollapse) {
        snapshot.traces = collapseRepeatedSpans(
          snapshot.traces,
          this.spanCollapse,
        );
      }
      return snapshot;
    }
    return undefined;
  }

  getActiveSpan(
    traceId: string,
    callerId: string | undefined,
  ): OngoingTraceEventNode | undefined {
    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    if (!refsByCaller) {
      return undefined;
    }
    const activeSpan = refsByCaller.get(callerId);
    return activeSpan;
  }

  async createManualSpan(
    traceId: string,
    callerId: string | undefined,
    name: string,
    spanFunction: (span: TraceSpanDelegate) => any,
  ) {
    // await new Promise((resolve) => setImmediate(resolve));

    // The caller may already have completed (its entry survives completion in
    // `refsByCaller`); it is still the right source for the class and method
    // labels, which outlive completion. Where the new span *attaches* is
    // decided by `attachToCaller`, which nests only under a live caller.
    const activeSpan = this.getActiveSpan(traceId, callerId);
    const snapshot = this.traceSnapshots.get(traceId);
    if (!activeSpan || !snapshot) {
      return spanFunction(new TraceSpanDelegate("", name, {}));
    }

    // Book the span in the same ledger auto spans use. Completion goes through
    // internalEndTraceStep, which increments refsMarkedAsComplete - without
    // the matching increment here, every completed manual span pushed the
    // completed count one ahead, and a trace holding one leaked auto span plus
    // one manual span read as complete: pluckSnapshot then shipped a
    // half-built tree whose ongoing node still held its circular `parent`
    // reference, and JSON.stringify threw away the whole flush window.
    snapshot.refsCounter += 1;

    const newNodeId = uuidv7();
    const startTime = performance.now();

    // Same as internalStartTraceStep: without an enter, the exit issued on
    // completion no-ops and the span's execution time is silently attributed
    // to its parent - profile correlation for manual spans found nothing.
    activeSliceRecorder()?.enter(traceId, newNodeId, startTime);
    const manualSpan: OngoingTraceEventNode = {
      // Same identity rule as auto spans: the span id *is* the caller id it is
      // registered under, so a log line written inside this span carries an id
      // that resolves back to this node.
      spanId: newNodeId,
      name,
      origin: "manual",
      type: "start",
      className: activeSpan.className,
      methodKey: activeSpan.methodKey,
      startTime,
      startOffset: this.toStartOffset(snapshot, startTime),
      children: [],
    };
    const refsByCaller = this.callerIdsByTraceId.get(traceId);
    this.attachToCaller(snapshot, refsByCaller, callerId, manualSpan);

    refsByCaller?.set(newNodeId, manualSpan);

    const onResponse = (res: unknown) => {
      // setImmediate
      this.internalEndTraceStep(
        traceId,
        newNodeId,
        manualSpan.className,
        manualSpan.methodKey,
        newNodeId,
      );
      return res;
    };
    const onError = (err: unknown) => {
      // setTimeout(
      //   () =>
      this.internalEndTraceStep(
        traceId,
        newNodeId,
        manualSpan.className,
        manualSpan.methodKey,
        newNodeId,
        err as Error | string | object,
      );
      //   0,
      // );
      // Re-throw the error to maintain original behavior
      throw err;
    };

    const tags = {} as Record<string, string | number | boolean>;
    const delegate = new TraceSpanDelegate(newNodeId, manualSpan.name, tags);
    manualSpan.tags = tags;
    const store = this.als.getStore();
    return this.als.run(
      new Map([...(store?.entries() ?? []), [CALLER_METADATA_KEY, newNodeId]]),
      () => {
        try {
          const result = spanFunction(delegate);
          if (result instanceof Promise) {
            return result.then(onResponse).catch(onError);
          }
          return onResponse(result);
        } catch (err) {
          onError(err);

          // Re-throw to maintain original behavior
          throw err;
        }
      },
    );
  }
}
