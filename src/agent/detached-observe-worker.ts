import type { IncomingMessage } from "http";
import type { createTelemetrySanitizer } from "./telemetry-wire-contract.js";
import type { describeIngestRefusal } from "../utils/ingest-refusal.util.js";

/**
 * What arrives on `workerData.config`.
 *
 * Declared beside the code that reads it and `import type`d by the side that
 * builds it (`detachedWorkerData`), so the two cannot drift: a key added here
 * and forgotten there is a compile error, not a worker quietly posting
 * `undefined` inside a protocol line.
 */
export interface DetachedWorkerConfig {
  endpoint: string;
  appKey?: string;
  appSecret?: string;
  /**
   * Milliseconds between the main thread's flushes, as clamped there: the
   * first pause after rejected credentials, which then doubles.
   */
  flushInterval: number;
  /** Plain JSON, so it travels as data; the sanitizer that reads it travels as source. */
  wireShapes: Parameters<typeof createTelemetrySanitizer>[0];
  /** `DEGRADED_MESSAGE_PREFIX`, as data - see where it is read below. */
  degradedPrefix: string;
  /** `PAUSED_MESSAGE_PREFIX`, as data, for the same reason. */
  pausedPrefix: string;
}

export interface DetachedWorkerData {
  sharedBuffer: SharedArrayBuffer;
  config: DetachedWorkerConfig;
}

export const detachedObserveWorker = (
  // The factory's *source* is inlined as this argument when the worker script
  // is assembled (see `ObserveAgentWorker.initializeWorker`) - a stringified
  // function cannot import it. Type-only import above; a value import would
  // compile and then throw inside the worker.
  createSanitizer?: typeof createTelemetrySanitizer,
  // Same arrangement: the helper that turns a 429 body into a sentence
  // travels as source. Optional so a worker assembled without it still
  // reports the refusal, just without the reason.
  describeRefusal?: typeof describeIngestRefusal,
) => {
  // This function body is stringified via .toString() and executed as a
  // standalone worker script, so it can't use static ES imports and must
  // require() its dependencies at runtime instead.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { parentPort, workerData } = require("worker_threads");
  const zlib = require("zlib");
  const http = require("http");
  const https = require("https");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // `workerData` carries the shared buffer plus the collector config: the
  // stringified function has no access to this module's configuration, so
  // everything it needs must arrive here.
  const { sharedBuffer, config } = workerData as DetachedWorkerData;

  const buffer = new Uint8Array(sharedBuffer);
  const lock = new Int32Array(sharedBuffer, 0, 1);
  const view = new DataView(sharedBuffer, 4, 4);
  const decoder = new TextDecoder();

  const telemetryUrl = `${config.endpoint}/applications/telemetry`;

  /**
   * Why the endpoint can never be reached, decided once from its shape; null
   * when it parses. A malformed URL otherwise fails the request exactly as a
   * refused connection does - an error with a `cause` - so without this the
   * operator is told to check that the collector is running when the fix is
   * the `endpoint` option. `new URL` alone does not settle it: a scheme-less
   * "localhost:4000" parses, with "localhost" as the scheme.
   */
  const endpointProblem = (() => {
    try {
      const { protocol } = new URL(telemetryUrl);
      return protocol === "http:" || protocol === "https:"
        ? null
        : `its scheme is "${protocol}" rather than http: or https:`;
    } catch {
      return "it is not a valid URL";
    }
  })();

  // Arrives as data rather than being imported: this function body is eval'd
  // with no module scope, so a reference to the exported constant would be a
  // `ReferenceError` here. Passed in so the prefix has a single definition
  // that `parseDegradedMessage` still matches.
  const degradedPrefix = config.degradedPrefix;
  const pausedPrefix = config.pausedPrefix;

  /**
   * Built here, used only when the collector answers 400. The shapes travel
   * through `workerData` (they are plain JSON); the factory travels as source.
   * Healthy batches never touch this - the flush path stays gzip-and-send.
   */
  const sanitizer =
    typeof createSanitizer === "function" && config.wireShapes
      ? createSanitizer(config.wireShapes)
      : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Encoding": "gzip",
    // The degraded replies this agent can tell apart - see `IngestMode` in
    // degraded-ingest.protocol.ts. A literal rather than data from `config`
    // like the prefixes: nothing in the agent reads it back, and a missing
    // config key would put a broken header on every batch. The value is
    // pinned by worker-degraded-reply.spec.ts.
    "x-observe-ingest-modes": "reduced, trimmed, paced, errors-only",
  };
  // Omitted rather than sent empty when unconfigured: a collector in
  // placeholder mode accepts an unauthenticated batch, and blank credentials
  // would be a 401 instead.
  if (config.appKey && config.appSecret) {
    headers["x-api-key"] = config.appKey;
    headers["x-api-secret"] = config.appSecret;
  }

  /**
   * How many times the collector has refused these credentials since
   * start-up.
   *
   * Reporting every rejection adds no information and once cost a line every
   * few seconds - 535 identical errors in half an hour, in the run that
   * prompted this - which buries whatever else the service was trying to
   * say. So the first is said in full and the rest are only counted.
   */
  let authRejections = 0;

  /**
   * How many rejections between reminders.
   *
   * Chosen when every flush was sent into the rejection, which made it
   * roughly hourly at the default five-second flush. Sends now back off (see
   * `authBackoffMs`) to one an hour, so at that flush the same count comes
   * round after about a month: a reminder for a process that has been failing
   * for that long, not the hourly line it used to be.
   */
  const AUTH_REJECTION_REPORT_EVERY = 720;

  /**
   * When sending may resume after the collector refused a batch: a 429, or
   * rejected credentials (401/403).
   *
   * Neither changes batch to batch - an account out of credits stays out for
   * minutes at least, and credentials are read once at start-up - so
   * retrying at the flush cadence only buys more refusals, each costing the
   * collector a request and this process a log line. So sends pause
   * outright. The main thread keeps overwriting the shared buffer with newer
   * batches in the meantime - the buffer holds exactly one, so pausing drops
   * data by replacement rather than growing a queue - and once the pause
   * lapses the next flush goes out normally. If the collector is still
   * refusing, it answers the same again and the pause restarts.
   */
  let pausedUntil = 0;

  /**
   * How long to pause when a 429 carries no usable Retry-After. Long enough
   * that a depleted account is not being polled, short enough that a topped-up
   * one resumes within minutes.
   */
  const RATE_LIMIT_PAUSE_MS = 5 * 60 * 1000;

  /**
   * The longest any pause lasts: the ceiling on a server-sent Retry-After, so
   * a bad header cannot park the worker for a day, and where the backoff after
   * rejected credentials stops doubling.
   */
  const PAUSE_MAX_MS = 60 * 60 * 1000;

  /**
   * The pause after the latest of a run of rejected credentials, before any
   * Retry-After: one flush interval after the first, doubling with each one
   * after it up to `PAUSE_MAX_MS`, then one probe an hour. 0 until the first,
   * and again once the collector accepts a batch.
   *
   * Every flush used to be sent into the rejection, and at the hosted
   * collector that added up: on 2026-10-15 it refused 1.87M batches - 38% of
   * every request it served - from about 2,000 addresses presenting a deleted
   * key, a wrong secret or none at all, many of them every five seconds for
   * weeks. Nothing changes for such a process until someone fixes its
   * credentials and restarts it. The quick first retries cover a collector
   * that refused a good key by mistake; the hourly probe picks up a fix on
   * its side within the hour.
   */
  let authBackoffMs = 0;

  /**
   * Where the backoff starts. Falls back to the default flush when the config
   * carries no usable interval, rather than not backing off at all.
   */
  const AUTH_BACKOFF_BASE_MS =
    Number.isFinite(config.flushInterval) && config.flushInterval > 0
      ? config.flushInterval
      : 5000;

  /**
   * The pause a response's Retry-After asks for, or null when it carries
   * none. Only the delta-seconds form is parsed - the HTTP-date form is rare
   * on refusals and mis-parsing it risks an enormous pause - and anything
   * absent, malformed, or out of range counts as none.
   */
  const retryAfterMs = (response: CollectorResponse): number | null => {
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, PAUSE_MAX_MS);
    }
    return null;
  };

  /**
   * How long to block waiting for the main thread to release the lock, and how
   * long to sleep when the buffer holds nothing.
   *
   * Both exist to keep this thread off the CPU while idle. The wait carries a
   * timeout rather than blocking forever so a notification that arrives between
   * the load and the wait cannot park this thread indefinitely; the sleep is
   * what stops an empty buffer becoming a spin loop, and its length only adds
   * latency to a flush the main thread performs on a timer anyway.
   */
  const LOCK_WAIT_MS = 100;
  const IDLE_SLEEP_MS = 50;

  /**
   * Takes the lock if it is free.
   *
   * One `compareExchange` rather than a read followed by a write: the main
   * thread contends for this same word, and between a load saying the lock was
   * free and a store taking it, the other side can take it too - leaving both
   * threads believing they hold it, one writing the buffer while the other
   * reads it. `compareExchange` stores only if the word is still 0 and returns
   * what was there, so the check and the take are one indivisible step.
   */
  const acquireLock = () => Atomics.compareExchange(lock, 0, 0, 1) === 0;

  /**
   * Blocks while the main thread holds the lock.
   *
   * `Atomics.wait` blocks while the word *equals* the expected value, so the
   * expected value here is 1 - locked - and the load first avoids the syscall
   * entirely when the lock is already free.
   */
  const waitWhileLocked = () => {
    if (Atomics.load(lock, 0) !== 0) {
      Atomics.wait(lock, 0, 1, LOCK_WAIT_MS);
    }
  };

  const releaseLock = () => {
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0);
  };
  const clearBuffer = () => view.setUint32(0, 0); // Reset length to 0
  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const gzipAsync = (data: string): Promise<Buffer> =>
    new Promise((resolve, reject) =>
      zlib.gzip(data, (err: Error | null, compressed: Buffer) => {
        if (err) {
          reject(err);
        } else {
          resolve(compressed);
        }
      }),
    );

  /**
   * How long a connection to the collector stays open between batches.
   *
   * Batches used to go through `fetch`, whose undici agent drops a socket
   * after 4 s idle - one second short of the default 5 s flush - so every
   * batch paid a new TCP connection and TLS handshake, the collector's
   * certificate chain included. At the hosted collector's load balancer on
   * 2026-10-08 that was 5.8-6.9M new connections a day for 4.5M requests,
   * and ~27 GB/day sent to agents of which response bodies were 4.4 GB.
   *
   * Thirty seconds outlasts the default flush and any `flushInterval` below
   * it, and stays inside common load-balancer idle timeouts (an ALB defaults
   * to 60 s), so the agent lets go of an idle connection before the server
   * does. A server announcing a shorter `Keep-Alive: timeout` is obeyed: the
   * Node agent closes one second before it. An idle socket is unref'd and
   * never holds the process open.
   */
  const KEEP_ALIVE_IDLE_MS = 30_000;

  // Chosen once: the endpoint cannot change, and a malformed one never gets
  // as far as a request (see `post`).
  const transport =
    !endpointProblem && new URL(telemetryUrl).protocol === "https:"
      ? https
      : http;
  const agent = new transport.Agent({
    keepAlive: true,
    timeout: KEEP_ALIVE_IDLE_MS,
  });

  /**
   * How long a send may go without any activity on its socket before it is
   * abandoned.
   *
   * The agent's `timeout` above only emits an event nobody acts on, and the
   * send holds the shared buffer's lock: a collector or proxy that accepts the
   * connection and never answers would otherwise stop every later batch for
   * the life of the process. Abandoned, it fails like any unreachable
   * collector - reported, the batch dropped, the lock released.
   */
  const REQUEST_TIMEOUT_MS = 15_000;

  /** What the code below reads from a collector reply. */
  interface CollectorResponse {
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
  }

  /**
   * One POST, with the reply read to the end before it resolves.
   *
   * Read whatever the status: a reply left unread keeps its socket busy, and
   * the next batch opens another connection - the 401/403 path never read
   * its body under `fetch`. Collector replies are a few hundred bytes.
   *
   * A transport failure rejects with the failure as `cause`, the shape the
   * reporting below reads (ECONNREFUSED and friends on `err.cause.code`), and
   * says whether the socket was a kept-alive one.
   */
  const request = (body: Buffer) =>
    new Promise<CollectorResponse>((resolve, reject) => {
      const req = transport.request(
        telemetryUrl,
        {
          method: "POST",
          agent,
          headers: { ...headers, "Content-Length": body.length },
        },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", (err: Error) =>
            reject(new Error("collector reply failed", { cause: err })),
          );
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: res.statusMessage ?? "",
              headers: {
                get: (name) => {
                  const value = res.headers[name.toLowerCase()];
                  if (value === undefined) {
                    return null;
                  }
                  return Array.isArray(value) ? value.join(", ") : value;
                },
              },
              text: async () => text,
              json: async () => JSON.parse(text),
            });
          });
        },
      );
      req.on("error", (err: Error) =>
        reject(
          Object.assign(
            new Error("request to the collector failed", { cause: err }),
            {
              reusedSocket: req.reusedSocket,
            },
          ),
        ),
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () =>
        req.destroy(
          Object.assign(
            new Error(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`),
            { code: "ETIMEDOUT" },
          ),
        ),
      );
      req.end(body);
    });

  /**
   * The request and nothing else, so what it throws is a transport failure.
   *
   * Sent once more, on a fresh socket, when a kept-alive socket was reset
   * before any reply: the server closed it while it sat idle and never read
   * the batch (ECONNRESET, or EPIPE when the reset landed before the write).
   * That is the race every keep-alive client has - Node documents this retry
   * on `request.reusedSocket`, and undici makes it for `fetch` on idempotent
   * requests - and without it a batch would be dropped and reported as an
   * unreachable collector.
   */
  const post = async (body: Buffer): Promise<CollectorResponse> => {
    if (endpointProblem) {
      throw new Error("the collector endpoint is not a valid http(s) URL", {
        cause: new Error(endpointProblem),
      });
    }
    try {
      return await request(body);
    } catch (err) {
      const failure = err as {
        reusedSocket?: boolean;
        cause?: { code?: string };
      };
      const code = failure.cause?.code;
      if (failure.reusedSocket && (code === "ECONNRESET" || code === "EPIPE")) {
        return request(body);
      }
      throw err;
    }
  };

  const postBatch = async (json: string) => post(await gzipAsync(json));

  /**
   * Last resort for a 400: brings the batch into contract entry by entry and
   * re-sends it once, so one bad entry costs itself rather than the batch.
   *
   * This is the only place the payload is ever parsed and re-serialized, and
   * it runs on this worker thread, only for a batch the collector has already
   * refused - a healthy application never pays for it. No retry loop: if the
   * repaired batch is refused again the problem is not one the contract
   * describes, and the generic error path reports it.
   *
   * Returns whether the repair path handled the batch (repaired and re-sent,
   * whatever the outcome); false means nothing was repairable and the caller
   * should report the original refusal.
   */
  const repairAndResend = async (json: string): Promise<boolean> => {
    if (!sanitizer) {
      return false;
    }
    try {
      const payload = JSON.parse(json);
      const repair = sanitizer.sanitizeBatch(payload);
      if (!repair.changed) {
        return false;
      }

      const shown = repair.problems.slice(0, 5).join("; ");
      const remainder = repair.problems.length - 5;
      const summary =
        shown +
        (remainder > 0 ? ` (and ${remainder} more)` : "") +
        (repair.dropped > 0
          ? `; dropped ${repair.dropped} unsalvageable entr${repair.dropped === 1 ? "y" : "ies"}`
          : "");

      const retry = await postBatch(JSON.stringify(payload));
      if (retry.ok) {
        // Error-level on purpose: the send recovered, but something produced
        // out-of-contract telemetry and the field names here are the lead.
        parentPort.postMessage(
          `Error: Telemetry batch was rejected (400) and repaired: ${summary}. The repaired batch was sent.`,
        );
      } else {
        const retryBody = await retry.text().catch(() => "");
        parentPort.postMessage(
          `Error: Telemetry batch was rejected (400), repaired (${summary}), and rejected again ` +
            `(${retry.status})${retryBody ? ` - ${retryBody.slice(0, 500)}` : ""}. The batch was dropped.`,
        );
      }
      return true;
    } catch {
      // An unparsable batch or a transport failure on the retry: fall back to
      // reporting the original refusal.
      return false;
    }
  };

  /**
   * Sends one batch, if there is one to send.
   *
   * Returns whether anything was sent, so the loop below knows to come back
   * immediately or to sleep first.
   */
  const sendInstrumentationJsonData = async () => {
    if (Date.now() < pausedUntil) {
      // Paused after a refusal: not even worth taking the lock. Returning
      // false routes through the idle sleep, and the main thread goes on
      // replacing the buffered batch with fresher ones.
      return false;
    }

    waitWhileLocked();

    if (!acquireLock()) {
      // Lost the race to the main thread, which is flushing. Nothing to report
      // - this is the ordinary contention the lock exists for - so the loop
      // simply comes back to it.
      return false;
    }

    try {
      const jsonLength = view.getUint32(0);
      if (jsonLength === 0) {
        // `finally` releases the lock on this path like every other.
        return false;
      }

      // Skip the first 4 bytes (lock) and the next 4 bytes (length)
      const jsonBytes = buffer.slice(8, 8 + jsonLength);
      const jsonStr = decoder.decode(jsonBytes);
      const compressed = await gzipAsync(jsonStr);

      // Only the request is in this `try`, so anything it throws is a
      // transport failure by construction and the outer catch is left for
      // faults in this worker. Telling the two apart by the shape of the error
      // instead - `post` puts ECONNREFUSED and friends on `err.cause` - holds
      // only until the first exception without one, such as a timeout on the
      // request, which would then be reported as an agent bug.
      let response: CollectorResponse;
      try {
        response = await post(compressed);
      } catch (err) {
        // `post` reports every transport failure the same opaque way and puts
        // the reason - ECONNREFUSED, ENOTFOUND, a TLS error - on `err.cause`.
        // Reporting only `err.message` would tell the operator nothing: not
        // what went wrong, and not which URL was tried.
        const cause = (err as { cause?: { code?: string; message?: string } })
          ?.cause;
        const reason = cause?.code ?? cause?.message;
        parentPort.postMessage(
          endpointProblem
            ? `Error: Could not send telemetry: \`endpoint\` is set to ` +
                `${JSON.stringify(config.endpoint)} and ${endpointProblem}. ` +
                `Fix the endpoint option.`
            : `Error: Could not reach the collector at ${telemetryUrl}` +
                (reason ? ` (${reason})` : "") +
                `. Check that it is running and that \`endpoint\` points at it.`,
        );
        // Discarded rather than retried - `clearBuffer` in `finally` - which
        // is the right call for a fixed-size buffer the application is still
        // writing into: holding it for a retry would block every batch behind
        // an unreachable collector.
        return true;
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          authRejections += 1;
          authBackoffMs =
            authBackoffMs === 0
              ? Math.min(AUTH_BACKOFF_BASE_MS, PAUSE_MAX_MS)
              : Math.min(authBackoffMs * 2, PAUSE_MAX_MS);
          // The collector's own word on when to come back wins. The backoff
          // still advances under it, so a collector that sends one only
          // some of the time cannot hold the retries at the flush cadence.
          pausedUntil = Date.now() + (retryAfterMs(response) ?? authBackoffMs);
          // The slot is left alone until then, which a final flush would
          // otherwise read as a send still in progress.
          parentPort.postMessage(`${pausedPrefix}${pausedUntil}`);

          // Said plainly, and once. The batch is well-formed and the
          // credentials are not accepted for this application; left as a
          // generic transport failure this reads as a network problem, and the
          // fix - appKey and appSecret - is nowhere in the message.
          if (authRejections === 1) {
            parentPort.postMessage(
              `Error: Telemetry rejected (${response.status}). Check that appKey and appSecret are valid; ` +
                `the application is taken from the key. Credentials are read once at start-up, so fixing them ` +
                `takes a restart. Until then sends back off to one attempt an hour and batches in between are ` +
                `dropped - further rejections are counted, not logged.`,
            );
          } else if (authRejections % AUTH_REJECTION_REPORT_EVERY === 0) {
            // A periodic reminder, rare enough not to bury anything. Without
            // it a process that has been dropping telemetry for weeks looks
            // exactly like one that is healthy.
            parentPort.postMessage(
              `Error: Telemetry still rejected (${response.status}); ${authRejections} attempts refused since ` +
                `start-up, and every batch in between was dropped.`,
            );
          }
          return true;
        }
        if (response.status === 429) {
          const pauseMs = retryAfterMs(response) ?? RATE_LIMIT_PAUSE_MS;
          pausedUntil = Date.now() + pauseMs;
          // The slot is left alone until then, which a final flush would
          // otherwise read as a send still in progress.
          parentPort.postMessage(`${pausedPrefix}${pausedUntil}`);

          // The body says which refusal this is - a quota, a quota frozen by
          // a declined payment, or a rate cap - and each needs a different
          // fix from the operator. Parsed defensively: a rate-cap body is
          // not the quota shape and an older collector sends none at all,
          // and neither may turn a refusal into an "unreachable" report.
          const body: unknown = await response.json().catch(() => undefined);
          const why =
            typeof describeRefusal === "function"
              ? describeRefusal(body)
              : "the account may be out of credits or over budget";

          // One line per pause window, so a long depletion reads as one line
          // every few minutes rather than one per flush. The batch is dropped
          // - `finally` clears the buffer - same as every other failure here.
          parentPort.postMessage(
            `Error: Telemetry rate-limited (429) - ${why}. ` +
              `Pausing sends for ${Math.round(pauseMs / 60000)} minute(s); batches in the meantime are dropped.`,
          );
          return true;
        }
        if (response.status === 400 && (await repairAndResend(jsonStr))) {
          return true;
        }
        // Read as text, defensively: an error body is not guaranteed to be
        // JSON, and a parse failure here must not fall through to the catch
        // below and report a reachable collector as unreachable.
        const errorBody = await response.text().catch(() => "");
        parentPort.postMessage(
          `Error: Failed to send data. ${response.statusText} (${response.status})` +
            (errorBody ? ` - ${errorBody.slice(0, 500)}` : ""),
        );
        return true;
      }

      // Accepted, so whatever refused these credentials no longer does: a
      // later rejection starts the backoff over from the flush interval.
      authBackoffMs = 0;

      /*
       * The collector answers 200 while it is discarding the spans in the
       * batch - an account past its plan's allowance, a paying one past its
       * trim threshold, or a Free one whose day passed its daily limit, keeps
       * its requests, jobs and errors and loses the trace trees of all but
       * its notable traces. A paying account whose overage is paused keeps
       * less again: its server errors, without their trees. Nothing in the
       * status says so, so the body is the only way to learn it, and an agent
       * that does not look keeps building, serializing and gzipping trees
       * that die on arrival.
       *
       * Read defensively and treated as absent on anything unexpected: an
       * older collector returns no body at all, and a parse failure here must
       * never turn a successful send into a reported failure.
       */
      const accepted: unknown = await response.json().catch(() => undefined);
      const reply = (
        typeof accepted === "object" && accepted !== null ? accepted : {}
      ) as {
        degraded?: unknown;
        trimmed?: unknown;
        paced?: unknown;
        errorsOnly?: unknown;
        reason?: unknown;
      };
      // `false`, `true`, `trimmed`, `paced` or `errors-only`. `trimmed`,
      // `paced` and `errorsOnly` say only why or how the spans are discarded,
      // so they count only beside `degraded`; a collector that sends none of
      // them gets exactly the line it always did.
      //
      // The collector never sends `trimmed` and `paced` together - trimming
      // is a paying account's, pacing a Free one's. Should a reply carry both,
      // `trimmed` wins, in the order the collector itself checks them: it is
      // the paying account's reading, and the one that promises nothing about
      // 00:00 UTC. `errorsOnly` wins over both, in the same order: a paused
      // account is answered errors-only whatever else holds for it.
      //
      // The pause's reason rides after a colon, for the notice - but only a
      // reason the main thread has words for. The value is the collector's;
      // anything else leaves the bare `errors-only`, which withholds just the
      // same and words the notice without a reason.
      const pauseReason =
        reply.reason === "spike" || reply.reason === "budget"
          ? `:${reply.reason}`
          : "";
      const verdict =
        reply.degraded !== true
          ? "false"
          : reply.errorsOnly === true
            ? `errors-only${pauseReason}`
            : reply.trimmed === true
              ? "trimmed"
              : reply.paced === true
                ? "paced"
                : "true";

      // A protocol line, not prose: the parent keys off the prefix and the
      // value, and is the side that decides what to do about it.
      parentPort.postMessage(`${degradedPrefix}${verdict}`);

      parentPort.postMessage(
        "Tracing and instrumentation data sent successfully",
      );
      return true;
    } catch (err) {
      // Not the request - that has its own catch above - so this is a fault
      // in the worker itself: decoding the buffer, compressing, reading the
      // reply or posting to the parent. Said so rather than blamed on the
      // network: an operator can report a stack line, and can do nothing with
      // the claim that a collector which just answered is unreachable.
      const cause = (err as { cause?: unknown })?.cause;
      const causeText =
        cause instanceof Error || typeof cause === "string"
          ? String(cause)
          : undefined;
      parentPort.postMessage(
        `Error: Telemetry worker failed while sending a batch to ${telemetryUrl} - ` +
          String(err) +
          (causeText === undefined ? "" : ` (cause: ${causeText})`) +
          `. This is most likely a fault in the observe agent rather than a ` +
          `connectivity problem; please report it.`,
      );
      return true;
    } finally {
      clearBuffer();
      releaseLock();
    }
  };

  /**
   * The worker's main loop.
   *
   * A flat loop, so the worker's liveness never depends on a recursive call.
   * Sleeping when there was nothing to send is what keeps an idle process off
   * the CPU: without it an empty buffer would be acquired, found empty and
   * released as fast as the thread can go.
   */
  const run = async () => {
    parentPort.postMessage("Ready to process instrumentation data");

    for (;;) {
      const sent = await sendInstrumentationJsonData();
      if (!sent) {
        await sleep(IDLE_SLEEP_MS);
      }
    }
  };

  run();
};
