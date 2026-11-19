import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import * as http from "http";
import * as https from "https";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "util";
import { gzip } from "zlib";
import { sendsToObserve } from "../agent/observe-reporting.util.js";
import type { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import type { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import type { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { readSdkVersion } from "../utils/sdk-version.util.js";
import {
  encodeOtlpJson,
  encodeOtlpProtobuf,
  OtlpScope,
} from "./otlp-encoders.js";
import {
  OtlpExportSettings,
  resolveOtlpSettings,
} from "./otlp-settings.util.js";
import {
  jobSnapshotSpans,
  OtlpAttribute,
  OtlpSpan,
  requestSnapshotSpans,
  toAttributes,
} from "./otlp-span.mapper.js";

const gzipAsync = promisify(gzip);

/**
 * The most spans waiting to be exported. Past it, a finished operation's
 * spans are dropped whole - never part of a tree - and counted.
 *
 * What bounds the process when the receiver is slow or down: spans wait
 * here while an export is retried, and a receiver that never comes back
 * must cost telemetry, not memory.
 */
const MAX_QUEUED_SPANS = 10_000;

/**
 * The most characters waiting to be exported, counted over every string the
 * waiting spans carry (see `charsOf`). Past it, as past `MAX_QUEUED_SPANS`,
 * a finished operation's spans are dropped whole and counted.
 *
 * A count of spans alone does not bound the memory: a span is as large as
 * its tags, its status and its exception event, and some of them are as
 * long as a client made them. Ten thousand spans that each carried a few
 * outgoing calls' URLs with a client's text in them ran the process out of
 * heap while the receiver was down.
 */
const MAX_QUEUED_CHARS = 32 * 1024 * 1024;

/**
 * The most spans one export carries. A full batch is sent at once rather
 * than at the next interval, so a busy service exports in step with what it
 * records instead of building up a backlog between ticks.
 */
const MAX_BATCH_SPANS = 1_000;

/**
 * The most characters one export carries, counted as for the queue: a batch
 * is full at whichever of the two it reaches first, and holds at least one
 * span. Receivers limit the size of what they take - a collector's request
 * body, the message size of whatever it passes spans on to - and a thousand
 * large spans in one export would be refused whole, every time it is tried.
 */
const MAX_BATCH_CHARS = 2 * 1024 * 1024;

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MIN_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

/**
 * The statuses OTLP/HTTP says a client should retry after - the receiver is
 * overloaded or briefly away. Anything else is an answer about the batch or
 * the credentials, which sending the batch again would not change.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/**
 * How often a refused batch may be refused again once a later export was
 * accepted, before it is dropped: what tells a batch the receiver will
 * never take from one a rate limiter turned away just after letting the
 * export before it through.
 */
const MAX_REFUSALS_ONCE_OUTLIVED = 3;

/** The first wait before an export is retried; it doubles to the ceiling. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** The longest a receiver's own `Retry-After` is obeyed for. */
const RETRY_AFTER_MAX_MS = 5 * 60_000;

/** How long an idle connection to the receiver is kept for the next batch. */
const KEEP_ALIVE_IDLE_MS = 30_000;

/**
 * The most of a receiver's reply that is read. Only its first 300 characters
 * are ever shown, and it is held and decoded on the application's thread:
 * past this, the reading stops and the connection goes with it, and the
 * status is acted on as it stands.
 */
const MAX_REPLY_BYTES = 64 * 1024;

/**
 * The most interim (1xx) replies one export sits through. Nothing it sends
 * asks for one, and each is parsed on the application's thread: how many of
 * them that thread works through is not the receiver's to choose. A proxy's
 * few ahead of the answer still pass.
 */
const MAX_INTERIM_REPLIES = 8;

/** The longest a timer runs; a longer delay would fire at once instead. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A batch the receiver turned away, waiting at the front of the queue. */
interface RefusedBatch {
  /** How many spans it is. */
  spans: number;
  /**
   * Whether an export was accepted since it was refused: the receiver is
   * there, so a refusal of it now is likely about what is in it.
   */
  outlived: boolean;
  /** How often it was refused since then. */
  refusalsOnceOutlived: number;
}

interface ReceiverReply {
  status: number;
  retryAfter: string | undefined;
  contentType: string | undefined;
  body: string;
}

/**
 * Exports what the agent records as OpenTelemetry traces, over OTLP/HTTP, to
 * whatever receiver `otlp` names - a collector, Jaeger, Tempo, Honeycomb, a
 * vendor's agent - beside what goes to Observe, never instead of it: an agent
 * that sends Observe nothing (see `sendsToObserve`) exports nothing either.
 * Part of OpenTelemetry interop, so it also takes `openTelemetry: true`: the
 * `traceparent` the spans nest under is read only with that on.
 *
 * Fed finished operations by the shared buffer, which decides what to hand
 * over: nothing until the collector takes the app's telemetry and its reply
 * grants export for the account's plan, and then - see `OtlpExportGrant` -
 * either everything, before anything the Observe side decides about it, or
 * only what NestJS Observe keeps. What it is fed has already been through
 * `tracesSampleRate`, `skipSpans` and `spanCollapse`, and through redaction.
 *
 * Runs on the application's thread, unlike the Observe worker: an export is
 * a small encode and an asynchronous request, compression runs on libuv's
 * pool, and none of it sits on a request's path. Every send runs outside the
 * agent's async context, so the agent never traces - or puts trace headers
 * on - its own exports.
 */
@Injectable()
export class OtlpTraceExporter implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OtlpTraceExporter.name);
  private readonly settings: OtlpExportSettings | undefined;
  private readonly resource: OtlpAttribute[] = [];
  /** Its version is read only once export is known to be on. */
  private readonly scope: OtlpScope = { name: "@nestjs/observe", version: "" };
  private readonly agent: http.Agent | undefined;
  private readonly queue: OtlpSpan[] = [];
  /** What `charsOf` counts in `queue`, kept as spans come and go. */
  private queuedChars = 0;
  /**
   * The batches the receiver turned away and that wait for another try,
   * oldest first. Their spans are the first `refusedSpans` of `queue`, in
   * the same order; everything behind them has not been sent yet.
   */
  private readonly refused: RefusedBatch[] = [];
  private refusedSpans = 0;
  private sending: Promise<void> | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private shutdownPromise: Promise<void> | null = null;
  /**
   * Set once shutdown has let go of the connection. An export still open
   * then fails as its socket goes, which is the shutdown, not the receiver,
   * and nothing will retry it.
   */
  private closed = false;

  /** No export starts before this (epoch ms): a retry is waiting. */
  private retryNotBefore = 0;
  private retryDelayMs = 0;
  /**
   * What the last failure was, while exports are failing: said once when it
   * starts or changes, and again when exports recover. Null while healthy.
   */
  private failure: string | null = null;
  /** Spans dropped since the last report of it. */
  private droppedSpans = 0;
  private reportedDrop = false;
  private reportedMappingFailure = false;
  /**
   * Why `otlp` is set and export still cannot run, said once at start-up;
   * null when it can, or when `otlp` is not set at all.
   */
  private readonly offReason: string | null = null;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly asyncLocalStorage: AsyncLocalStorage<Map<any, any>>,
  ) {
    if (!options.otlp) {
      return;
    }
    // Off with the agent, which says so itself and records nothing.
    if (options.enabled === false) {
      return;
    }
    if (options.openTelemetry !== true) {
      this.offReason =
        "OTLP export is off: `otlp` takes `openTelemetry: true` as well, which reads the `traceparent` " +
        "the exported spans nest under and sends one on every call out.";
      return;
    }
    if (!sendsToObserve(options)) {
      this.offReason =
        "OTLP export is off: it runs beside reporting to NestJS Observe, never instead of it, " +
        "and this agent reports nothing to it - it has no credentials for the hosted collector, or still has `nest new`'s placeholders.";
      return;
    }
    const { settings, warnings } = resolveOtlpSettings(options.otlp, {
      serviceId: options.serviceId,
      serviceVersion: options.serviceVersion,
    });
    for (const warning of warnings) {
      this.logger.warn(warning);
    }
    if (!settings) {
      return;
    }
    this.settings = settings;
    this.resource = toAttributes(settings.resource).attributes;
    this.scope = { name: "@nestjs/observe", version: readSdkVersion() };
    const transport = settings.url.startsWith("https:") ? https : http;
    this.agent = new transport.Agent({
      keepAlive: true,
      timeout: KEEP_ALIVE_IDLE_MS,
    });
  }

  /**
   * Whether `otlp` is set up and export can run once the collector grants
   * it - `openTelemetry` on, reporting to NestJS Observe, a usable endpoint.
   */
  get enabled(): boolean {
    return this.settings !== undefined;
  }

  /** Where export goes, once it is enabled. */
  get url(): string | undefined {
    return this.settings?.url;
  }

  onModuleInit() {
    if (this.offReason) {
      this.logger.warn(this.offReason);
    }
    if (!this.settings) {
      return;
    }
    const interval = Math.max(
      this.options.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS,
      MIN_FLUSH_INTERVAL_MS,
    );
    this.flushTimer = setInterval(() => this.flush(), interval);
    this.flushTimer.unref();
    this.logger.log(
      `OTLP export to ${this.settings.url} (${this.settings.protocol}) starts once NestJS Observe ` +
        "accepts this app's first batch and says what its plan includes.",
    );
  }

  /**
   * Queues a finished request's spans - its own span, and with `withTree` the
   * spans under it. Never throws into the caller.
   *
   * Left out when the request arrived in a trace its caller sampled out
   * (`traceparent` flags 00), as an OpenTelemetry SDK sampling by its parent
   * would leave it out: the caller exports none of that trace, so these
   * spans would only hang in the backend under a parent it never gets.
   */
  exportRequestSnapshot(snapshot: RequestSnapshot, withTree = true): void {
    if (!this.settings) {
      return;
    }
    try {
      const context = this.operationTraceRegistry.traceContextOf(snapshot);
      if (context && !context.sampled) {
        return;
      }
      this.enqueue(requestSnapshotSpans(snapshot, context, withTree));
    } catch (error) {
      this.reportMappingFailure(error);
    }
  }

  /**
   * Queues a finished job's spans - its own span, and with `withTree` the
   * spans under it. Never throws into the caller.
   *
   * Left out, as a request is, when the trace it was handed on in is one an
   * OpenTelemetry SDK in this process sampled out.
   */
  exportJobSnapshot(snapshot: JobSnapshot, withTree = true): void {
    if (!this.settings) {
      return;
    }
    try {
      const context = this.operationTraceRegistry.traceContextOf(snapshot);
      if (context && !context.sampled) {
        return;
      }
      this.enqueue(jobSnapshotSpans(snapshot, context, withTree));
    } catch (error) {
      this.reportMappingFailure(error);
    }
  }

  /**
   * Starts an export of what is queued, unless one is already under way, a
   * retry is waiting out its delay, or there is nothing to send.
   */
  flush(): void {
    if (
      !this.settings ||
      this.sending ||
      this.queue.length === 0 ||
      Date.now() < this.retryNotBefore
    ) {
      return;
    }
    // A batch the receiver turned away goes again once a later one got
    // through, or when nothing later is waiting to go ahead of it; until
    // then, later batches go first.
    const oldest = this.refused[0];
    let batch: OtlpSpan[];
    let retried: RefusedBatch | undefined;
    if (
      oldest &&
      (oldest.outlived || this.queue.length === this.refusedSpans)
    ) {
      retried = this.refused.shift()!;
      this.refusedSpans -= retried.spans;
      batch = this.queue.splice(0, retried.spans);
      this.queuedChars -= totalChars(batch);
    } else {
      batch = this.takeBatch(this.refusedSpans);
    }
    this.sending = this.send(batch, retried).finally(() => {
      this.sending = null;
      if (this.shutdownPromise) {
        return;
      }
      // A backlog left behind a full batch goes straight out after it, as
      // does a refused batch a later one has just outlived.
      if (this.refused[0]?.outlived || this.holdsFullBatch()) {
        this.flush();
      }
    });
  }

  onApplicationShutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutDown();
    return this.shutdownPromise;
  }

  private enqueue(spans: OtlpSpan[]): void {
    if (!this.fits(spans)) {
      this.droppedSpans += spans.length;
      if (!this.reportedDrop) {
        this.reportedDrop = true;
        this.logger.warn(
          `OTLP export is falling behind: the spans waiting for ${this.settings?.url} have reached the limit of what is held (${MAX_QUEUED_SPANS} spans, or ${MAX_QUEUED_CHARS} characters of text in them), so newer traces are dropped until it catches up. Dropped spans are counted and reported when it does.`,
        );
      }
      return;
    }
    this.queueAtEnd(spans);
    if (this.holdsFullBatch()) {
      this.flush();
    }
  }

  /** Whether `spans` can wait in the queue as it stands, within both limits. */
  private fits(spans: OtlpSpan[]): boolean {
    return (
      this.queue.length + spans.length <= MAX_QUEUED_SPANS &&
      this.queuedChars + totalChars(spans) <= MAX_QUEUED_CHARS
    );
  }

  private queueAtEnd(spans: OtlpSpan[]): void {
    for (const span of spans) {
      this.queue.push(span);
    }
    this.queuedChars += totalChars(spans);
  }

  /** Whether what waits fills a batch by either of its limits. */
  private holdsFullBatch(): boolean {
    return (
      this.queue.length >= MAX_BATCH_SPANS ||
      this.queuedChars >= MAX_BATCH_CHARS
    );
  }

  /**
   * Takes the next batch off the queue from `start`: as many spans as fit
   * in `MAX_BATCH_SPANS` and `MAX_BATCH_CHARS`, and always at least one, so
   * a span larger than a batch on its own still goes out.
   */
  private takeBatch(start: number): OtlpSpan[] {
    let count = 0;
    let chars = 0;
    while (start + count < this.queue.length && count < MAX_BATCH_SPANS) {
      const next = charsOf(this.queue[start + count]);
      if (count > 0 && chars + next > MAX_BATCH_CHARS) {
        break;
      }
      chars += next;
      count += 1;
    }
    this.queuedChars -= chars;
    return this.queue.splice(start, count);
  }

  /**
   * One export - of `retried`, when it is a refused batch going again.
   * Resolves whatever happens: a failure is reported and either put back
   * for a retry or dropped, never thrown.
   */
  private async send(
    batch: OtlpSpan[],
    retried: RefusedBatch | undefined,
  ): Promise<void> {
    const settings = this.settings!;
    let body: Buffer;
    try {
      const encoded =
        settings.protocol === "http/json"
          ? Buffer.from(encodeOtlpJson(this.resource, this.scope, batch))
          : encodeOtlpProtobuf(this.resource, this.scope, batch);
      body =
        settings.compression === "gzip" ? await gzipAsync(encoded) : encoded;
    } catch (error) {
      // Nothing a retry would change: the batch is lost, and said so.
      this.reportFailure(
        `the batch could not be encoded (${String(error)})`,
        false,
      );
      return;
    }

    let reply: ReceiverReply;
    try {
      // Outside the agent's context: the request below would otherwise be
      // traced, and given trace headers, as part of whatever operation's
      // completion happened to start this export.
      reply = await this.asyncLocalStorage.exit(() => this.post(body));
    } catch (error) {
      if (this.closed) {
        return;
      }
      const code = (error as { code?: string }).code;
      const retrying = this.retryLater(batch, retried, undefined);
      this.reportFailure(
        `the receiver could not be reached (${code ?? String(error)})`,
        retrying,
      );
      return;
    }

    if (reply.status >= 200 && reply.status < 300) {
      this.recovered(batch.length);
      return;
    }
    const retrying =
      RETRYABLE_STATUSES.has(reply.status) &&
      this.retryLater(batch, retried, reply.retryAfter);
    const detail =
      reply.body && /json|text/.test(reply.contentType ?? "")
        ? ` - ${reply.body.slice(0, 300)}`
        : "";
    this.reportFailure(`it answered ${reply.status}${detail}`, retrying);
  }

  /**
   * Sets a batch the receiver turned away aside for a retry, behind the
   * batches refused before it and ahead of everything else, if it still
   * fits; and holds exports back for the receiver's `Retry-After` or the
   * next backoff step. Returns whether it will be retried.
   *
   * A receiver that is away refuses whatever it is sent, but one may also
   * refuse a batch for what is in it - larger than what it passes spans on
   * to takes, say - with the same statuses. Put back at the front and sent
   * again first, as it was, such a batch was refused for as long as the
   * process ran, took in every span queued behind it at each try, and not
   * one trace was exported after it. So later batches now go ahead of it,
   * and once one of them got through it goes again first, a second apart
   * or as long as `Retry-After` asks, and is dropped - counted, and the
   * backoff left as the accepted export reset it - when it has been
   * refused `MAX_REFUSALS_ONCE_OUTLIVED` times more: a receiver that only
   * limits how often it is sent to takes it within those. During an outage
   * nothing gets through, so nothing is dropped before the queue is full;
   * each refused batch goes again once the receiver is back. At shutdown
   * nothing is put back: the drain gives each batch one try.
   */
  private retryLater(
    batch: OtlpSpan[],
    retried: RefusedBatch | undefined,
    retryAfter: string | undefined,
  ): boolean {
    if (this.shutdownPromise) {
      this.droppedSpans += batch.length;
      return false;
    }
    if (retried?.outlived) {
      // The receiver took an export since this one was first refused: it
      // is not away, so this does not add to the backoff.
      retried.refusalsOnceOutlived += 1;
      if (
        retried.refusalsOnceOutlived >= MAX_REFUSALS_ONCE_OUTLIVED ||
        !this.fits(batch)
      ) {
        this.droppedSpans += batch.length;
        this.holdBack(retryAfter, 0);
        return false;
      }
      this.queue.unshift(...batch);
      this.refused.unshift(retried);
      this.refusedSpans += batch.length;
      this.queuedChars += totalChars(batch);
      this.holdBack(retryAfter, RETRY_BASE_MS);
      return true;
    }
    if (this.fits(batch)) {
      const refused: RefusedBatch = {
        spans: batch.length,
        outlived: false,
        refusalsOnceOutlived: 0,
      };
      if (retried) {
        this.queue.unshift(...batch);
        this.refused.unshift(refused);
      } else {
        this.queue.splice(this.refusedSpans, 0, ...batch);
        this.refused.push(refused);
      }
      this.refusedSpans += batch.length;
      this.queuedChars += totalChars(batch);
    } else {
      this.droppedSpans += batch.length;
    }
    this.retryDelayMs =
      this.retryDelayMs === 0
        ? RETRY_BASE_MS
        : Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    this.holdBack(retryAfter, this.retryDelayMs);
    return true;
  }

  /**
   * Holds exports back for the receiver's `Retry-After`, or else for
   * `otherwiseMs`.
   *
   * Never sooner than the first backoff step when the receiver asks.
   * `Retry-After` is whole seconds, so no receiver that follows HTTP asks
   * for less; one that answered `0.0000001` had every flush - and the
   * follow-up after each full batch - send the same export again at once,
   * as fast as the application's thread could encode it.
   */
  private holdBack(retryAfter: string | undefined, otherwiseMs: number): void {
    const asked = Number(retryAfter);
    const delay =
      Number.isFinite(asked) && asked > 0
        ? Math.min(Math.max(asked * 1000, RETRY_BASE_MS), RETRY_AFTER_MAX_MS)
        : otherwiseMs;
    this.retryNotBefore = Date.now() + delay;
  }

  /**
   * Clears the failure state after an accepted export, and says so. Every
   * batch refused before it has now outlived a refusal that may have been
   * the receiver's, and goes again next.
   */
  private recovered(exported: number): void {
    for (const refused of this.refused) {
      refused.outlived = true;
    }
    this.retryDelayMs = 0;
    this.retryNotBefore = 0;
    if (this.failure !== null || this.droppedSpans > 0) {
      const dropped =
        this.droppedSpans > 0
          ? `; ${this.droppedSpans} spans were dropped in the meantime`
          : "";
      this.logger.log(
        `OTLP export to ${this.settings?.url} is working again${dropped}.`,
      );
    }
    this.failure = null;
    this.droppedSpans = 0;
    this.reportedDrop = false;
    if (this.options.debug) {
      this.logger.debug(`Exported ${exported} spans over OTLP.`);
    }
  }

  /**
   * Says that exports are failing, once when it starts and again only when
   * the reason changes: a receiver that is down for an hour is one line, not
   * one per flush.
   */
  private reportFailure(reason: string, retrying: boolean): void {
    if (this.failure === reason) {
      if (this.options.debug) {
        this.logger.debug(`OTLP export failed again: ${reason}.`);
      }
      return;
    }
    this.failure = reason;
    this.logger.warn(
      `OTLP export to ${this.settings?.url} failed: ${reason}. ` +
        (retrying
          ? "Retrying with backoff; spans wait meanwhile, up to a limit."
          : "That batch was dropped.") +
        " Said again only if the reason changes.",
    );
  }

  private reportMappingFailure(error: unknown): void {
    if (this.reportedMappingFailure) {
      return;
    }
    this.reportedMappingFailure = true;
    this.logger.warn(
      `An operation could not be converted to OTLP spans and was left out of the export; later ones are not reported: ${String(error)}`,
    );
  }

  private post(body: Buffer): Promise<ReceiverReply> {
    const settings = this.settings!;
    const transport = settings.url.startsWith("https:") ? https : http;
    return new Promise<ReceiverReply>((resolve, reject) => {
      const request = transport.request(
        settings.url,
        {
          method: "POST",
          agent: this.agent,
          headers: {
            ...settings.headers,
            "Content-Type":
              settings.protocol === "http/json"
                ? "application/json"
                : "application/x-protobuf",
            ...(settings.compression === "gzip"
              ? { "Content-Encoding": "gzip" }
              : {}),
            "Content-Length": body.length,
            "User-Agent": `nestjs-observe/${this.scope.version}`,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          const settle = () => {
            const retryAfter = response.headers["retry-after"];
            resolve({
              status: response.statusCode ?? 0,
              retryAfter: Array.isArray(retryAfter)
                ? retryAfter[0]
                : retryAfter,
              contentType: response.headers["content-type"],
              body: Buffer.concat(
                chunks,
                Math.min(received, MAX_REPLY_BYTES),
              ).toString("utf8"),
            });
            // A reply that ends before the batch has been written leaves a
            // socket that is never pooled, timed out or closed again.
            if (!request.writableFinished) {
              request.destroy();
            }
          };
          response.on("data", (chunk: Buffer) => {
            if (received >= MAX_REPLY_BYTES) {
              return;
            }
            chunks.push(chunk);
            received += chunk.length;
            if (received >= MAX_REPLY_BYTES) {
              response.destroy();
              settle();
            }
          });
          response.on("error", reject);
          response.on("end", settle);
        },
      );
      request.on("error", reject);
      // A 101 with `Connection: Upgrade` is no response to Node: it emits
      // only this, and destroys the socket without an error. Unheard, the
      // export would never settle and every later one would wait behind it.
      // No upgrade was asked for: it is a status like any other refusal.
      request.on("upgrade", (response, socket) => {
        socket.destroy();
        resolve({
          status: response.statusCode ?? 101,
          retryAfter: undefined,
          contentType: undefined,
          body: "",
        });
      });
      // A limit on the export as a whole, which is what `timeoutMillis` is.
      // `request.setTimeout` measures silence on the socket instead and
      // starts over with every byte: a receiver that went on writing -
      // interim replies, a body a byte at a time - would hold this export,
      // and every one queued behind it, open for as long as it liked.
      const deadline = setTimeout(
        () =>
          request.destroy(
            Object.assign(
              new Error(`no answer within ${settings.timeoutMs} ms`),
              { code: "ETIMEDOUT" },
            ),
          ),
        Math.min(settings.timeoutMs, MAX_TIMER_MS),
      );
      request.on("close", () => clearTimeout(deadline));
      let interimReplies = 0;
      request.on("information", () => {
        if (++interimReplies > MAX_INTERIM_REPLIES) {
          request.destroy(
            new Error(
              `it sent more than ${MAX_INTERIM_REPLIES} interim (1xx) replies`,
            ),
          );
        }
      });
      request.end(body);
    });
  }

  /**
   * Exports what is still queued, for at most `shutdownFlushTimeout`, then
   * lets go of the connection.
   *
   * Operations finish their traces a tick after their response, and one
   * whose spans were still open waits a further second in the registry, so
   * the drain waits for both before deciding it is done - as the Observe
   * worker's final flush does. Each batch still waiting is sent once, with
   * no backoff in between: one the receiver fails is not retried - shutdown
   * is not the time to wait one out - and the drain goes on with the next,
   * so the batch a receiver refuses for what is in it no longer takes every
   * later one with it.
   */
  private async shutDown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.settings) {
      return;
    }
    const timeoutMs =
      this.options.shutdownFlushTimeout ?? DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS;
    try {
      if (timeoutMs > 0) {
        await this.drain(timeoutMs);
      }
    } catch (error) {
      if (this.options.debug) {
        this.logger.debug(`Final OTLP export failed: ${String(error)}`);
      }
    } finally {
      this.closed = true;
      this.agent?.destroy();
    }
  }

  private async drain(timeoutMs: number): Promise<void> {
    const deadline = process.uptime() * 1000 + timeoutMs;
    await sleep(0);
    for (;;) {
      const remaining = deadline - process.uptime() * 1000;
      if (remaining <= 0) {
        if (this.options.debug && this.queue.length > 0) {
          this.logger.debug(
            `Final OTLP export did not finish within ${timeoutMs}ms; ${this.queue.length} spans were not exported.`,
          );
        }
        return;
      }
      if (this.sending) {
        const timeout = new AbortController();
        await Promise.race([
          this.sending,
          sleep(remaining, undefined, { signal: timeout.signal }).catch(
            () => undefined,
          ),
        ]);
        timeout.abort();
        continue;
      }
      if (this.operationTraceRegistry.hasSnapshotsAwaitingCompletion()) {
        await sleep(Math.min(10, remaining));
        continue;
      }
      if (this.queue.length === 0) {
        return;
      }
      this.retryNotBefore = 0;
      this.flush();
    }
  }
}

/** What `charsOf` has counted, so a span is walked once however often it moves. */
const countedChars = new WeakMap<OtlpSpan, number>();

/**
 * How many characters of text a span carries: its ids and name, its trace
 * state and status message, and the keys and string values of its
 * attributes and its events'. What the queue and a batch are measured in -
 * not the bytes an export takes, which the encoding decides, but what grows
 * with them.
 */
function charsOf(span: OtlpSpan): number {
  let chars = countedChars.get(span);
  if (chars !== undefined) {
    return chars;
  }
  chars =
    span.traceId.length +
    span.spanId.length +
    (span.parentSpanId?.length ?? 0) +
    (span.traceState?.length ?? 0) +
    span.name.length +
    (span.status?.message?.length ?? 0) +
    attributeChars(span.attributes);
  for (const event of span.events) {
    chars += event.name.length + attributeChars(event.attributes);
  }
  countedChars.set(span, chars);
  return chars;
}

function attributeChars(attributes: OtlpAttribute[]): number {
  let chars = 0;
  for (const { key, value } of attributes) {
    chars += key.length + (typeof value === "string" ? value.length : 0);
  }
  return chars;
}

function totalChars(spans: OtlpSpan[]): number {
  let chars = 0;
  for (const span of spans) {
    chars += charsOf(span);
  }
  return chars;
}
