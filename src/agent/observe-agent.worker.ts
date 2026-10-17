import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from "@nestjs/common";
import { hostname } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "worker_threads";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { OBSERVE_OPTIONS } from "../observe.constants.js";
import { CpuProfilerService } from "../profiling/cpu-profiler.service.js";
import { ProfileUploader } from "../profiling/profile-uploader.js";
import {
  setActiveSliceRecorder,
  SpanSliceRecorder,
} from "../profiling/span-slice-recorder.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import {
  IngestMode,
  OveragePauseReason,
  parseDegradedMessage,
  parseOveragePauseReason,
  parsePausedMessage,
} from "./degraded-ingest.protocol.js";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";

const DEFAULT_RUNTIME_METRICS_INTERVAL = 60000; // 60 seconds
const MIN_RUNTIME_METRICS_INTERVAL = 30000; // 30 seconds
const DEFAULT_FLUSH_INTERVAL = 5000; // 5 seconds

/**
 * The hosted collector. Unlike a collector in placeholder mode, it accepts
 * nothing without credentials.
 */
const HOSTED_COLLECTOR_ENDPOINT = "https://observe-api.nestjs.com";

/**
 * Where signals are posted when `endpoint` is not configured.
 */
const DEFAULT_COLLECTOR_ENDPOINT =
  process.env.OBSERVE_ENDPOINT ?? HOSTED_COLLECTOR_ENDPOINT;
const MIN_FLUSH_INTERVAL = 1000; // 1 second

/**
 * How long shutdown waits for buffered telemetry to reach the collector before
 * terminating the worker anyway, unless `shutdownFlushTimeout` says otherwise.
 *
 * Several times a healthy round trip to the hosted collector - gzip, a POST,
 * a few-hundred-byte reply, a fresh TLS handshake if the kept-alive socket has
 * gone - and well inside the grace period an orchestrator gives a process
 * after SIGTERM (30 s on ECS and Kubernetes by default), which also has to
 * cover the application's own shutdown hooks. The worker gives up on a silent
 * collector only after its own, much longer, request timeout, so this is what
 * keeps such a collector from holding shutdown open.
 */
const FINAL_FLUSH_TIMEOUT_MS = 2000;

/**
 * How often the final flush looks at the shared slot while the worker is
 * sending. Not what bounds the drain: every batch also waits out the worker's
 * 50 ms idle sleep before it is picked up, which is why the final flush sends
 * the log backlog as one batch rather than 250 lines per round trip.
 */
const FINAL_FLUSH_POLL_MS = 10;

/**
 * The shortest window a last runtime sample is taken over at shutdown.
 *
 * A sample's CPU and event-loop figures are rates over the time since the
 * previous one. Over a few milliseconds - a process that has only just
 * started, or one stopped straight after a scheduled sample - they read as
 * a pegged CPU and a saturated loop, and mean nothing.
 */
const MIN_FINAL_RUNTIME_WINDOW_MS = 10_000;

/**
 * The credentials `nest new --observe` writes into `AppModule`.
 *
 * A project fresh from the generator has these until someone signs up, so
 * they mean "not connected yet", not "wrong": sending them only buys a 401
 * and an `Error:` line on the very first `npm run start`.
 */
const SCAFFOLD_APP_KEY = "YOUR_APP_KEY";
const SCAFFOLD_APP_SECRET = "YOUR_APP_SECRET";

const DEMO_URL = "https://www.observe-demo.nestjs.com/dashboard";
const SIGN_UP_URL = "https://observe.nestjs.com";

@Injectable()
export class ObserveAgentWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ObserveAgentWorker.name);
  // Null before `initializeWorker` and again after termination, which is what
  // the shutdown path below checks for.
  private worker: Worker | null = null;
  /**
   * Set while `onApplicationShutdown` is tearing the worker down.
   *
   * `Worker#terminate()` stops the thread abruptly, so Node reports exit code
   * 1 - indistinguishable, at the `exit` listener, from a worker that died on
   * its own. Without this flag a graceful shutdown logs an error and spawns a
   * replacement thread that nothing will ever stop, which keeps the event loop
   * alive and can hold the process open.
   */
  private isTerminating = false;
  private flushInterval: NodeJS.Timeout;
  private runtimeMetricsInterval: NodeJS.Timeout | null = null;
  /** When the last runtime sample was taken, or sampling started. */
  private lastRuntimeSampleAt = 0;
  private cpuProfiler: CpuProfilerService | null = null;
  /** The one shutdown, however many times Nest asks for it. */
  private shutdownPromise: Promise<void> | null = null;
  /**
   * Until when the worker has said it will send nothing (epoch ms) - after a
   * 429 or rejected credentials, until that pause lapses. Read by the final
   * flush only.
   */
  private sendsPausedUntil = 0;

  constructor(
    private readonly observeAgentSharedBuffer: ObserveAgentSharedBuffer,
    @Inject(OBSERVE_OPTIONS)
    private readonly options: ObserveModuleOptionsWithDefaults,
    private readonly nodeRuntimeMetricsService: NodeRuntimeMetricsService,
    // Optional so the agent can be built on its own, as its suites build it;
    // the module always provides it.
    @Optional()
    private readonly operationTraceRegistry?: OperationTraceRegistry,
  ) {}

  onModuleInit() {
    // Settled before the worker starts, which backs off from this interval
    // after rejected credentials - as does a worker restarted later on.
    let flushIntervalTime =
      this.options.flushInterval ?? DEFAULT_FLUSH_INTERVAL;
    if (flushIntervalTime < MIN_FLUSH_INTERVAL) {
      this.logger.warn(
        `Flush interval is too short (${flushIntervalTime}ms). Setting to minimum of ${MIN_FLUSH_INTERVAL}ms.`,
      );
      // Clamp the value the timer is armed with, not just the recorded option:
      // the warning above used to be a lie, and a `flushInterval: 50` flushed
      // twenty times a second while claiming it had been raised to 1s.
      flushIntervalTime = MIN_FLUSH_INTERVAL;
      this.options.flushInterval = MIN_FLUSH_INTERVAL;
    }

    if (this.hasScaffoldCredentials) {
      // Nothing is sent, so there is no worker to start. The flush timer below
      // still runs and empties the buffer, which the instrumentation keeps
      // writing into either way.
      this.logger.log(
        `Observe is installed but not connected yet: appKey and appSecret are still the placeholders from nest new, so no telemetry is sent. ` +
          `See what this app will look like: ${DEMO_URL} - then create a free account at ${SIGN_UP_URL} for your own key and secret.`,
      );
    } else if (this.lacksHostedCredentials) {
      // The same arrangement, said as a warning: this is a deployment missing
      // its configuration, not a project fresh from the generator.
      const unset =
        !this.options.appKey && !this.options.appSecret
          ? "appKey and appSecret are"
          : !this.options.appKey
            ? "appKey is"
            : "appSecret is";
      this.logger.warn(
        `Observe is installed but sends nothing: ${unset} not set, and the hosted collector accepts no telemetry without a key and a secret. ` +
          `If they come from the environment, check that both variables reach this process, then restart it. Create a key and secret at ${SIGN_UP_URL}.`,
      );
    } else {
      this.initializeWorker();
    }

    this.flushInterval = setInterval(() => this.flush(), flushIntervalTime);

    if (!this.sendsNothing) {
      this.startRuntimeMetrics();
    }

    // Continuous profiling is shelved: a flame graph asks more of a reader than
    // most services' owners want to give it, and the signal is not worth the
    // sampling cost until there is a UI that makes it legible. The
    // implementation is kept and tested - restore this call and re-register the
    // /profiles routes to bring it back.
    // this.startContinuousProfiling();
  }

  /**
   * Starts the runtime-metrics collector: memory, CPU, GC, event loop.
   */
  private startRuntimeMetrics(): void {
    if (!this.options.runtimeMetrics) {
      return;
    }

    let interval =
      this.options.runtimeMetricsInterval ?? DEFAULT_RUNTIME_METRICS_INTERVAL;

    if (interval < MIN_RUNTIME_METRICS_INTERVAL) {
      this.logger.warn(
        `Runtime metrics interval is too short (${interval}ms). Setting to minimum of ${MIN_RUNTIME_METRICS_INTERVAL}ms.`,
      );
      interval = MIN_RUNTIME_METRICS_INTERVAL;
    }

    this.lastRuntimeSampleAt = Date.now();
    this.runtimeMetricsInterval = setInterval(() => {
      this.lastRuntimeSampleAt = Date.now();
      this.observeAgentSharedBuffer.addNodeRuntimeMetrics(
        this.nodeRuntimeMetricsService.collectNodeRuntimeMetrics(),
      );
    }, interval);

    if (this.options.debug) {
      this.logger.debug(`Collecting runtime metrics every ${interval}ms.`);
    }
  }

  /**
   * Starts the sampling profiler, if the application asked for it.
   *
   * Distinct from `runtimeMetrics`, which gauges how loaded the process is.
   * This one samples stacks to say which code was running, and it is the only
   * one of the two with a cost on the hot path - so it stays off unless asked
   * for, rather than following any existing flag.
   *
   * Currently unreachable: `profiling` is commented out of `ObserveOptions` and
   * the call in `onModuleInit` is commented out with it. The body is kept
   * compiling rather than deleted, so restoring the feature is uncommenting two
   * lines instead of recovering this from history. The local type below is what
   * `ObserveOptions.profiling` declared, and is the thing to delete when the
   * real option comes back.
   */
  private startContinuousProfiling(): void {
    const profiling = (
      this.options as {
        profiling?: {
          enabled?: boolean;
          sampleRateHz?: number;
          windowMs?: number;
          dutyMs?: number;
          maxCpuPercent?: number;
        };
      }
    ).profiling;

    if (!profiling?.enabled) {
      return;
    }

    const slices = new SpanSliceRecorder();
    const uploader = new ProfileUploader({
      endpoint: this.endpoint,
      appKey: this.options.appKey,
      appSecret: this.options.appSecret,
      // One node is one process. Two replicas of a service must not merge into
      // a single tree, so the identity has to distinguish them.
      serviceNode: `${hostname()}:${process.pid}`,
      onError: (message) => this.logger.warn(message),
    });

    this.cpuProfiler = new CpuProfilerService(slices, {
      sampleRateHz: profiling.sampleRateHz,
      windowMs: profiling.windowMs,
      dutyMs: profiling.dutyMs,
      maxCpuPercent: profiling.maxCpuPercent,
      onWindow: (window, sampleRateHz) =>
        uploader.enqueue(window, sampleRateHz),
      onDisabled: (reason) => {
        // Said out loud rather than degraded quietly: the customer has asked
        // for profiling and is no longer getting it.
        this.logger.warn(`Continuous profiling stopped - ${reason}`);
        setActiveSliceRecorder(null);
      },
    });

    // Only now does the instrumentation start recording span slices. With
    // profiling off this stays null and every span boundary costs one null
    // check.
    setActiveSliceRecorder(slices);

    void this.cpuProfiler.start().catch((err) => {
      this.logger.warn(`Continuous profiling failed to start: ${String(err)}`);
      setActiveSliceRecorder(null);
    });

    this.logger.log("Continuous profiling enabled.");
  }

  /**
   * Sends what is still buffered, then stops the worker.
   *
   * Runs in `onApplicationShutdown` rather than `beforeApplicationShutdown`
   * on purpose. Nest closes an application as destroy hooks, then
   * before-shutdown hooks, then the HTTP server (letting in-flight requests
   * finish, and record their snapshots), then shutdown hooks - so this is the
   * last point at which requests are still being recorded. Forwarded log
   * lines stop earlier, in the destroy phase (see StdoutForwarderService).
   *
   * Shutdown hooks run module by module, the root module first and global
   * modules last - but global modules among themselves in reverse order of
   * registration. One registered before ObserveModule shuts down after this
   * hook, and what it records then stays in the main-thread buffer, unsent:
   * BullModule, whose workers let their active jobs finish in their own
   * shutdown hook, is the common case. Hence "import ObserveModule first" in
   * the README; with `forRootAsync({ global: false })` this runs before every
   * global module.
   *
   * On a signal, none of this runs unless the application called
   * `app.enableShutdownHooks()` - without it Node ends the process at once.
   *
   * Called once however many times it is asked: `enableShutdownHooks()` plus
   * an application's own signal handler calling `close()` both get here, and a
   * second run would otherwise race the first for the worker.
   */
  onApplicationShutdown(): Promise<void> {
    this.shutdownPromise ??= this.shutDown();
    return this.shutdownPromise;
  }

  private async shutDown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }

    const timeoutMs =
      this.options.shutdownFlushTimeout ?? FINAL_FLUSH_TIMEOUT_MS;
    // Before the first `await`: on Nest 11 every shutdown hook in this module
    // starts at once, and NodeRuntimeMetricsService stops its monitors as soon
    // as this one yields. Nest 12 runs this hook first, as this class depends
    // on that service.
    const sampleRuntimeMetricsLast =
      timeoutMs > 0 && this.worker !== null && this.takeFinalRuntimeSample();
    if (this.runtimeMetricsInterval) {
      clearInterval(this.runtimeMetricsInterval);
    }

    if (this.cpuProfiler) {
      setActiveSliceRecorder(null);
      await this.cpuProfiler.stop();
      this.cpuProfiler = null;
    }

    // No worker - placeholder or missing credentials, or never started -
    // means nothing was ever going to be sent, so there is nothing to flush
    // either.
    const worker = this.worker;
    if (!worker) {
      return;
    }

    // Set before the final flush rather than just before `terminate`: a worker
    // that dies while draining must not be replaced by one nothing will stop.
    this.isTerminating = true;

    if (timeoutMs > 0) {
      try {
        await this.flushBeforeShutdown(
          worker,
          timeoutMs,
          sampleRuntimeMetricsLast,
        );
      } catch (error) {
        // `flush` reports its own failures; this is anything else, and a
        // shutdown hook that throws would only trade lost telemetry for a
        // shutdown that does not finish cleanly.
        if (this.options.debug) {
          this.logger.debug(
            `Final flush before shutdown failed: ${String(error)}`,
          );
        }
      }
    }

    await worker.terminate();

    if (this.options.debug) {
      this.logger.debug("Worker terminated successfully.");
    }
    this.worker = null;
  }

  /**
   * Hands everything still buffered to the worker and waits for it to be
   * sent, for at most `timeoutMs`.
   *
   * Telemetry sits in up to three places at shutdown: the main-thread batch
   * (plus log lines held back for later batches), the shared slot, and the
   * worker's in-flight request - the worker keeps the slot locked and filled
   * until the collector has answered. The slot holds one batch, and a plain
   * `flush()` skips while the worker holds it, so this is a loop: wait for the
   * slot to empty, write the next batch, repeat until there is nothing left to
   * write and the worker is done with the last one. Waiting for an empty slot
   * before each write is also what stops the final flush overwriting a batch
   * the worker has not read yet.
   *
   * Timed with `node:timers` and `process.uptime()` rather than the global
   * `setTimeout` and `Date.now()`, which test suites' fake timers replace - a
   * shutdown waiting on those would never finish.
   *
   * Never throws for a send: a refused or failed batch is reported by the
   * worker as it always is, and clears the slot like a sent one. A worker
   * paused after a 429, or refused for its credentials, says so and is not
   * waited for.
   */
  private async flushBeforeShutdown(
    worker: Worker,
    timeoutMs: number,
    sampleRuntimeMetrics: boolean,
  ): Promise<void> {
    const buffer = this.observeAgentSharedBuffer;
    const deadline = process.uptime() * 1000 + timeoutMs;

    // A worker that dies mid-drain will never empty the slot; there is no
    // point waiting out the deadline for it.
    let exited = false;
    const onExit = () => {
      exited = true;
    };
    worker.once("exit", onExit);

    try {
      // Every protocol records its snapshot from a `setTimeout(0)` after the
      // response or job has finished, so the last requests a process served
      // may not be in the buffer yet - and an empty buffer would end this
      // before they land. A zero timer set now fires after the ones already
      // queued, and the microtasks each of those starts run before it does.
      // A trace whose spans were still open waits a further second in the
      // registry; the loop below waits for those too.
      await sleep(0);

      for (;;) {
        if (exited) {
          if (this.options.debug) {
            this.logger.debug(
              "Worker exited before the final flush completed. Telemetry still buffered was not sent.",
            );
          }
          return;
        }

        if (Date.now() < this.sendsPausedUntil) {
          if (this.options.debug) {
            this.logger.debug(
              "The collector refused the last batch and sends are paused. Telemetry still buffered was not sent.",
            );
          }
          return;
        }

        if (!buffer.hasBatchAwaitingWorker()) {
          // The whole backlog in one batch once the batch before it has gone,
          // not 250 lines per round trip: each batch also waits out the
          // worker's idle sleep, and a full backlog would outlast the deadline.
          if (buffer.isBufferEmpty()) {
            buffer.drainPendingLogs(Number.POSITIVE_INFINITY);
          }
          this.flush();

          if (
            !buffer.hasBatchAwaitingWorker() &&
            buffer.isBufferEmpty() &&
            !buffer.hasPendingLogs() &&
            !this.operationTraceRegistry?.hasSnapshotsAwaitingCompletion()
          ) {
            if (!sampleRuntimeMetrics) {
              return;
            }
            // Taken only now that whatever was already buffered has gone: a
            // batch carries a single runtime sample, and each sample covers the
            // window since the previous one, so taking this earlier could
            // replace an unsent sample and lose its window.
            sampleRuntimeMetrics = false;
            this.addFinalRuntimeMetrics();
            continue;
          }
        }

        if (process.uptime() * 1000 >= deadline) {
          if (this.options.debug) {
            this.logger.debug(
              `Final flush did not complete within ${timeoutMs}ms. Telemetry still buffered was not sent.`,
            );
          }
          return;
        }

        await sleep(FINAL_FLUSH_POLL_MS);
      }
    } finally {
      worker.off("exit", onExit);
    }
  }

  /**
   * Adds the last runtime sample to the outgoing batch, or says it must wait
   * until that batch has gone.
   *
   * Skipped when its window would be shorter than
   * `MIN_FINAL_RUNTIME_WINDOW_MS`. Otherwise it rides the first batch the
   * final flush sends - unless that batch already carries a sample, which it
   * would replace; then it is taken last (returns `true`), when on Nest 11
   * the monitors may already have stopped.
   */
  private takeFinalRuntimeSample(): boolean {
    if (
      !this.runtimeMetricsInterval ||
      Date.now() - this.lastRuntimeSampleAt < MIN_FINAL_RUNTIME_WINDOW_MS
    ) {
      return false;
    }
    if (this.observeAgentSharedBuffer.hasRuntimeMetrics()) {
      return true;
    }
    this.addFinalRuntimeMetrics();
    return false;
  }

  /**
   * The runtime-metrics window between the last scheduled sample and now.
   */
  private addFinalRuntimeMetrics() {
    try {
      this.observeAgentSharedBuffer.addNodeRuntimeMetrics(
        this.nodeRuntimeMetricsService.collectNodeRuntimeMetrics(),
      );
    } catch (error) {
      if (this.options.debug) {
        this.logger.debug(
          `Could not collect final runtime metrics: ${String(error)}`,
        );
      }
    }
  }

  private get hasScaffoldCredentials(): boolean {
    return (
      this.options.appKey === SCAFFOLD_APP_KEY &&
      this.options.appSecret === SCAFFOLD_APP_SECRET
    );
  }

  /**
   * Whether credentials are missing and the collector is the hosted one,
   * which answers every batch without them with a 401.
   *
   * The worker leaves both headers off when either half is unset, which a
   * collector in placeholder mode accepts, so a collector of the user's own
   * still gets those batches. The hosted collector refuses them for as long
   * as the process runs: on 2026-10-15 that was 42% of the 1.87M batches it
   * refused, from processes deployed without their environment variables,
   * some of them posting every five seconds for weeks.
   */
  private get lacksHostedCredentials(): boolean {
    return (
      (!this.options.appKey || !this.options.appSecret) &&
      this.isHostedCollector
    );
  }

  /**
   * Whether `endpoint` - set, from `OBSERVE_ENDPOINT`, or the default - is the
   * hosted collector. Compared by host, so a trailing slash or a capital
   * letter cannot pass it off as a collector of the user's own.
   */
  private get isHostedCollector(): boolean {
    try {
      return (
        new URL(this.endpoint).hostname ===
        new URL(HOSTED_COLLECTOR_ENDPOINT).hostname
      );
    } catch {
      // Not a URL at all; the worker says so when it tries to send.
      return false;
    }
  }

  /** Whether nothing will be sent, so there is no worker to feed. */
  private get sendsNothing(): boolean {
    return this.hasScaffoldCredentials || this.lacksHostedCredentials;
  }

  private get endpoint(): string {
    return this.options.endpoint ?? DEFAULT_COLLECTOR_ENDPOINT;
  }

  /**
   * Says out loud when credentials are about to cross the network unencrypted.
   *
   * `endpoint` is free-form and both halves of the agent attach `x-api-key` /
   * `x-api-secret` to every request against it. Over `http://` to anything but
   * the local machine, those headers are readable by every hop in between -
   * a misconfiguration worth one warning, not a refusal: private networks and
   * tunnels exist, and an agent that stops reporting over a scheme choice
   * punishes the operator harder than the mistake does.
   */
  private warnIfCredentialsSentInClear(): void {
    if (!this.options.appKey && !this.options.appSecret) {
      return;
    }
    try {
      const url = new URL(this.endpoint);
      const loopback =
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]" ||
        url.hostname === "::1";
      if (url.protocol === "http:" && !loopback) {
        this.logger.warn(
          `The collector endpoint "${url.origin}" uses plain HTTP: appKey and appSecret will be sent unencrypted. Use https:// unless the network path is fully trusted.`,
        );
      }
    } catch {
      // An unparsable endpoint fails loudly elsewhere; nothing to add here.
    }
  }

  initializeWorker() {
    this.warnIfCredentialsSentInClear();
    // Source and data both come from the assembly module, which the worker's
    // tests build from too: the worker is eval'd with no module scope, so the
    // code it needs travels as stringified functions and the configuration as
    // `workerData`, and the one place that puts them together is the one
    // place a forgotten value can be caught.
    this.worker = new Worker(detachedWorkerSource(), {
      eval: true,
      workerData: detachedWorkerData({
        sharedBuffer: this.observeAgentSharedBuffer.sharedBuffer,
        endpoint: this.endpoint,
        appKey: this.options.appKey,
        appSecret: this.options.appSecret,
        // Clamped by `onModuleInit` before the first worker starts.
        flushInterval: this.options.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
      }),
    });
    this.watchWorker(this.worker);

    this.logger.log("Observe agent worker initialized.");
  }

  /** The worker's messages, errors, and the restart when it dies. */
  private watchWorker(worker: Worker) {
    worker.on("message", (msg) => this.handleMessage(msg));
    worker.on("error", (error) => this.handleError(error));
    worker.on("exit", (code) => {
      if (this.isTerminating) {
        this.logger.debug("Worker exited on shutdown.");
        return;
      }
      if (code !== 0) {
        this.logger.error(
          `Worker stopped with exit code ${code}. Restarting worker...`,
        );
        this.initializeWorker(); // Restart the worker
      } else {
        this.logger.debug("Worker exited gracefully.");
      }
    });
  }

  handleMessage(msg: string) {
    const pausedUntil = parsePausedMessage(msg);
    if (pausedUntil !== null) {
      this.sendsPausedUntil = pausedUntil;
      return;
    }

    const mode = parseDegradedMessage(msg);
    if (mode !== null) {
      this.applyIngestMode(mode, parseOveragePauseReason(msg));
      return;
    }

    if (msg.includes("Error:")) {
      this.logger.error(msg);
      return;
    }

    if (this.options.debug) {
      this.logger.debug(msg);
    }
  }

  /**
   * What the last reply said the collector does with spans.
   *
   * Kept beside the log rather than read from the buffer so the notice fires
   * once per transition: an account sits in this state for days, and a line
   * per flush would bury the one thing worth reading.
   */
  private reportedMode: IngestMode = "full";

  /**
   * Why the account's overage is paused, when the last reply was errors-only
   * and gave a reason this agent can word; null otherwise. Kept beside
   * `reportedMode` for the same reason, and a pause whose reason changes -
   * spike protection's, then a spent budget's - is said again.
   */
  private reportedPauseReason: OveragePauseReason | null = null;

  /**
   * Stops sending trace trees the collector has told us it is throwing away,
   * and says so once - and again only when the reason changes.
   *
   * Said at `warn` rather than `debug`: the application is still being
   * observed, most waterfalls are not being kept, and a developer who finds
   * that out by opening a trace and seeing nothing has been let down by an
   * agent that knew. Each line says what is still kept, because the traces
   * worth opening - server errors, slow requests, failed jobs - still are.
   *
   * Except while the account's overage is paused, when next to nothing is
   * kept and nothing comes back on its own before the month ends: that line
   * says so, and who can change it.
   */
  private applyIngestMode(
    mode: IngestMode,
    pauseReason: OveragePauseReason | null = null,
  ) {
    // Reduced, trimmed and paced withhold the same trees, and errors-only
    // everything but server errors; the buffer tells them apart.
    this.observeAgentSharedBuffer.setIngestMode(mode);

    if (
      mode === this.reportedMode &&
      pauseReason === this.reportedPauseReason
    ) {
      return;
    }
    if (mode === "errors-only") {
      // Not "most traces arrive without their spans": requests, jobs and
      // logs stop too, and the operator may have to ask whoever holds the
      // account to resume them.
      const why =
        pauseReason === "spike"
          ? "spike protection paused this account's overage"
          : pauseReason === "budget"
            ? "this account's monthly overage budget is spent, so its overage is paused"
            : "this account's overage is paused";
      const resume =
        pauseReason === "budget"
          ? "resumes it or raises the budget"
          : "resumes it";
      this.logger.warn(
        `Observe: ${why}. Only server errors and failed jobs are sent now, without their spans; ` +
          "every other request and job, and every log line, is held back. Runtime and custom metrics are still recorded. " +
          `Full collection returns when someone ${resume} at /dashboard/billing/usage, or at 00:00 UTC on the 1st.`,
      );
    } else if (mode === "reduced") {
      this.logger.warn(
        "Observe: this account has used its monthly allowance, so most traces now arrive without their spans. " +
          "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
          "See /dashboard/billing/usage.",
      );
    } else if (mode === "trimmed") {
      this.logger.warn(
        "Observe: traces are now trimmed past this account's threshold to keep its bill down. " +
          "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
          'To keep every trace, turn on "Keep full traces" at /dashboard/billing/usage.',
      );
    } else if (mode === "paced") {
      // Not the reduced line: the allowance is not spent, and the spans come
      // back at midnight UTC without the operator doing anything.
      this.logger.warn(
        "Observe: this account's day passed the Free plan's daily limit, so most traces arrive without their spans until 00:00 UTC. " +
          "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
          "See /dashboard/billing/usage.",
      );
    } else if (this.reportedMode === "errors-only") {
      // Not only the spans: every request, job and log line is back.
      this.logger.log(
        "Observe: this account's overage is no longer paused, so everything is recorded again.",
      );
    } else {
      this.logger.log("Observe: spans are being recorded again.");
    }
    this.reportedMode = mode;
    this.reportedPauseReason = pauseReason;
  }

  handleError(error: Error) {
    this.logger.error(error);
  }

  flush() {
    // Before the emptiness check, not after: lines held back from an earlier
    // batch are the only thing that might need sending once the process has
    // gone quiet, and an empty buffer would otherwise return here and strand
    // them until shutdown.
    this.observeAgentSharedBuffer.drainPendingLogs();

    if (this.sendsNothing) {
      this.observeAgentSharedBuffer.resetMainThreadBuffer();
      return;
    }

    if (this.observeAgentSharedBuffer.isBufferEmpty()) {
      return;
    }

    if (this.observeAgentSharedBuffer.isBufferLocked()) {
      if (this.options.debug) {
        this.logger.debug(
          "Shared buffer is locked, cannot flush data to worker. Skipping flush for now.",
        );
      }
      return;
    }

    if (!this.observeAgentSharedBuffer.acquireLock()) {
      if (this.options.debug) {
        this.logger.debug(
          "Failed to acquire lock on shared buffer. Skipping flush for now.",
        );
      }
      return;
    }

    try {
      this.observeAgentSharedBuffer.encodeAndWrite();
    } catch (error) {
      this.logger.error("Error during flush:", error);
    } finally {
      this.observeAgentSharedBuffer.releaseLock();
      this.observeAgentSharedBuffer.resetMainThreadBuffer();
    }
  }
}
