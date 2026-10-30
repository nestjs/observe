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
 * The most spans one export carries. A full batch is sent at once rather
 * than at the next interval, so a busy service exports in step with what it
 * records instead of building up a backlog between ticks.
 */
const MAX_BATCH_SPANS = 1_000;

const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
const MIN_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_SHUTDOWN_FLUSH_TIMEOUT_MS = 2_000;

/**
 * The statuses OTLP/HTTP says a client should retry after - the receiver is
 * overloaded or briefly away. Anything else is an answer about the batch or
 * the credentials, which sending the batch again would not change.
 */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** The first wait before an export is retried; it doubles to the ceiling. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** The longest a receiver's own `Retry-After` is obeyed for. */
const RETRY_AFTER_MAX_MS = 5 * 60_000;

/** How long an idle connection to the receiver is kept for the next batch. */
const KEEP_ALIVE_IDLE_MS = 30_000;

interface ReceiverReply {
  status: number;
  retryAfter: string | undefined;
  contentType: string | undefined;
  body: string;
}

/**
 * Exports what the agent records as OpenTelemetry traces, over OTLP/HTTP, to
 * whatever receiver `otlp` names - a collector, Jaeger, Tempo, Honeycomb, a
 * vendor's agent - alongside what goes to Observe, or instead of it.
 *
 * Fed every finished operation at the point all protocols hand theirs to the
 * shared buffer, and before anything the Observe side decides about it: the
 * Observe collector's answers (an account over its allowance, a paused
 * overage) and `maxTracesPerBatch` shape what goes to Observe, not what goes
 * here, and so does whether Observe credentials are set at all. What it is
 * fed has already been through `tracesSampleRate`, `skipSpans` and
 * `spanCollapse`, and through redaction.
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
  /** Whether the last export failed - the final flush does not retry it. */
  private lastSendFailed = false;
  /**
   * What the last failure was, while exports are failing: said once when it
   * starts or changes, and again when exports recover. Null while healthy.
   */
  private failure: string | null = null;
  /** Spans dropped since the last report of it. */
  private droppedSpans = 0;
  private reportedDrop = false;
  private reportedMappingFailure = false;

  constructor(
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly operationTraceRegistry: OperationTraceRegistry,
    private readonly asyncLocalStorage: AsyncLocalStorage<Map<any, any>>,
  ) {
    if (options.enabled === false) {
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

  /** Whether `otlp` asked for export and it can run. */
  get enabled(): boolean {
    return this.settings !== undefined;
  }

  onModuleInit() {
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
      `Exporting traces over OTLP (${this.settings.protocol}) to ${this.settings.url}.`,
    );
  }

  /** Queues a finished request's spans. Never throws into the caller. */
  exportRequestSnapshot(snapshot: RequestSnapshot): void {
    if (!this.settings) {
      return;
    }
    try {
      this.enqueue(
        requestSnapshotSpans(
          snapshot,
          this.operationTraceRegistry.traceContextOf(snapshot),
        ),
      );
    } catch (error) {
      this.reportMappingFailure(error);
    }
  }

  /** Queues a finished job's spans. Never throws into the caller. */
  exportJobSnapshot(snapshot: JobSnapshot): void {
    if (!this.settings) {
      return;
    }
    try {
      this.enqueue(jobSnapshotSpans(snapshot));
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
    const batch = this.queue.splice(0, MAX_BATCH_SPANS);
    this.sending = this.send(batch).finally(() => {
      this.sending = null;
      // A backlog left behind a full batch goes straight out after it.
      if (this.queue.length >= MAX_BATCH_SPANS && !this.shutdownPromise) {
        this.flush();
      }
    });
  }

  onApplicationShutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutDown();
    return this.shutdownPromise;
  }

  private enqueue(spans: OtlpSpan[]): void {
    if (this.queue.length + spans.length > MAX_QUEUED_SPANS) {
      this.droppedSpans += spans.length;
      if (!this.reportedDrop) {
        this.reportedDrop = true;
        this.logger.warn(
          `OTLP export is falling behind: more than ${MAX_QUEUED_SPANS} spans are waiting for ${this.settings?.url}, so newer traces are dropped until it catches up. Dropped spans are counted and reported when it does.`,
        );
      }
      return;
    }
    for (const span of spans) {
      this.queue.push(span);
    }
    if (this.queue.length >= MAX_BATCH_SPANS) {
      this.flush();
    }
  }

  /**
   * One export. Resolves whatever happens: a failure is reported and either
   * put back for a retry or dropped, never thrown.
   */
  private async send(batch: OtlpSpan[]): Promise<void> {
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
      this.lastSendFailed = true;
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
      this.retryLater(batch, undefined);
      this.reportFailure(
        `the receiver could not be reached (${code ?? String(error)})`,
        true,
      );
      return;
    }

    if (reply.status >= 200 && reply.status < 300) {
      this.recovered(batch.length);
      return;
    }
    const retryable = RETRYABLE_STATUSES.has(reply.status);
    if (retryable) {
      this.retryLater(batch, reply.retryAfter);
    } else {
      this.lastSendFailed = true;
    }
    const detail =
      reply.body && /json|text/.test(reply.contentType ?? "")
        ? ` - ${reply.body.slice(0, 300)}`
        : "";
    this.reportFailure(`it answered ${reply.status}${detail}`, retryable);
  }

  /**
   * Puts a batch back at the front of the queue, if it still fits, and holds
   * exports back for the receiver's `Retry-After` or the next backoff step.
   */
  private retryLater(batch: OtlpSpan[], retryAfter: string | undefined): void {
    this.lastSendFailed = true;
    if (this.queue.length + batch.length <= MAX_QUEUED_SPANS) {
      this.queue.unshift(...batch);
    } else {
      this.droppedSpans += batch.length;
    }
    this.retryDelayMs =
      this.retryDelayMs === 0
        ? RETRY_BASE_MS
        : Math.min(this.retryDelayMs * 2, RETRY_MAX_MS);
    const asked = Number(retryAfter);
    const delay =
      Number.isFinite(asked) && asked > 0
        ? Math.min(asked * 1000, RETRY_AFTER_MAX_MS)
        : this.retryDelayMs;
    this.retryNotBefore = Date.now() + delay;
  }

  /** Clears the failure state after an accepted export, and says so. */
  private recovered(exported: number): void {
    this.lastSendFailed = false;
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
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const retryAfter = response.headers["retry-after"];
            resolve({
              status: response.statusCode ?? 0,
              retryAfter: Array.isArray(retryAfter)
                ? retryAfter[0]
                : retryAfter,
              contentType: response.headers["content-type"],
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("error", reject);
      request.setTimeout(settings.timeoutMs, () =>
        request.destroy(
          Object.assign(
            new Error(`no answer within ${settings.timeoutMs} ms`),
            { code: "ETIMEDOUT" },
          ),
        ),
      );
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
   * worker's final flush does. A receiver that fails the final export is not
   * retried: shutdown is not the time to wait out a backoff.
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
        if (this.lastSendFailed) {
          return;
        }
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
