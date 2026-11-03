import { Worker } from "worker_threads";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEGRADED_MESSAGE_PREFIX,
  IngestMode,
  parseDegradedMessage,
  parseOveragePauseReason,
} from "./degraded-ingest.protocol.js";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";
import {
  OTLP_EXPORT_INGEST_MODE,
  OTLP_EXPORT_MESSAGE_PREFIX,
} from "../otlp/otlp-export-grant.js";
import {
  readSdkVersion,
  UNKNOWN_SDK_VERSION,
} from "../utils/sdk-version.util.js";

/** A shared buffer holding one batch, laid out as the agent lays it out. */
const bufferWithBatch = (json: string) => {
  const sharedBuffer = new SharedArrayBuffer(64 * 1024);
  const bytes = new Uint8Array(sharedBuffer);
  const length = new DataView(sharedBuffer, 4, 4);
  const encoded = new TextEncoder().encode(json);
  bytes.set(encoded, 8);
  length.setUint32(0, encoded.length);
  return sharedBuffer;
};

/**
 * The protocol line the worker posts for one accepted batch.
 *
 * Built from the same source and data `ObserveAgentWorker` uses, for the
 * reason worker-failure-reporting.spec.ts gives: the worker is eval'd with no
 * module scope, and a copy would pass whatever the real assembly forgot. An
 * `Error:` from the worker fails the wait - an accepted batch is not one.
 */
const verdictFor = async (
  endpoint: string,
  credentials: { appKey?: string; appSecret?: string } = {
    appKey: "k",
    appSecret: "s",
  },
) => {
  const worker = new Worker(detachedWorkerSource(), {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer: bufferWithBatch(JSON.stringify({ traces: [] })),
      endpoint,
      ...credentials,
      flushInterval: 5000,
    }),
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker posted no verdict")),
        5_000,
      );
      worker.on("message", (msg: string) => {
        if (msg.startsWith(DEGRADED_MESSAGE_PREFIX)) {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.startsWith("Error:")) {
          clearTimeout(timer);
          reject(new Error(msg));
        }
      });
      worker.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } finally {
    await worker.terminate();
  }
};

type Respond = (req: IncomingMessage, res: ServerResponse) => void;

/** Accepts the batch: 200 with `body` as JSON, or with no body at all. */
const acceptWith =
  (body?: unknown): Respond =>
  (req, res) => {
    req.resume();
    req.on("end", () => {
      if (body === undefined) {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  };

describe("what the detached worker makes of an accepted batch's reply", () => {
  let collector: Server;
  let endpoint: string;
  let respond: Respond = acceptWith({ degraded: false });

  beforeAll(async () => {
    collector = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  // Value posted, the reply it is posted for, that reply's body, and what the
  // main thread reads the line as.
  it.each([
    // The only degraded reply before trimming existed. It has to keep meaning
    // what it meant, or every account on an older collector reads as
    // something else.
    [
      "true",
      "an older collector's degraded reply",
      { degraded: true },
      "reduced",
    ],
    [
      "trimmed",
      "a trimmed account's reply",
      { degraded: true, trimmed: true },
      "trimmed",
    ],
    [
      "paced",
      "a paced Free account's reply",
      { degraded: true, paced: true },
      "paced",
    ],
    ["false", "a reply keeping every span", { degraded: false }, "full"],
    ["false", "a reply with no body", undefined, "full"],
    // `trimmed` and `paced` say why spans are discarded, never whether:
    // `degraded` alone decides that, as it always has.
    ["false", "`trimmed` without `degraded`", { trimmed: true }, "full"],
    ["false", "`paced` without `degraded`", { paced: true }, "full"],
    [
      "false",
      "`errorsOnly` without `degraded`",
      { errorsOnly: true, reason: "spike" },
      "full",
    ],
    // The collector never sends both. Should one, `trimmed` wins, in the order
    // the collector checks them: the reading that promises nothing about
    // 00:00 UTC.
    [
      "trimmed",
      "a reply carrying both `trimmed` and `paced`",
      { degraded: true, trimmed: true, paced: true },
      "trimmed",
    ],
  ])(
    "posts `%s` for %s",
    async (value, _reply, body, mode) => {
      respond = acceptWith(body);

      const verdict = await verdictFor(endpoint);

      expect(verdict).toBe(`${DEGRADED_MESSAGE_PREFIX}${value}`);
      expect(parseDegradedMessage(verdict)).toBe(mode);
      expect(parseOveragePauseReason(verdict)).toBeNull();
    },
    20_000,
  );

  // A paying account whose overage is paused, answered as an agent that
  // lists `errors-only` is: value posted, the reply, its body, and the reason
  // the main thread reads off the line.
  it.each([
    [
      "errors-only:spike",
      "an overage paused by spike protection",
      { degraded: true, errorsOnly: true, reason: "spike" },
      "spike",
    ],
    [
      "errors-only:budget",
      "an overage paused by a spent budget",
      { degraded: true, errorsOnly: true, reason: "budget" },
      "budget",
    ],
    // The collector leaves `reason` out when the pause it read gave none.
    [
      "errors-only",
      "a pause without a reason",
      { degraded: true, errorsOnly: true },
      null,
    ],
    // The reason is the collector's, and words a log line: one the main
    // thread has no words for is left off, and withholds just the same.
    [
      "errors-only",
      "a reason this agent has no words for",
      { degraded: true, errorsOnly: true, reason: "dunning" },
      null,
    ],
    [
      "errors-only",
      "a reason that is not a string",
      { degraded: true, errorsOnly: true, reason: { spike: true } },
      null,
    ],
    // `errorsOnly` wins over both, in the order the collector checks them: a
    // paused account is answered errors-only whatever else holds for it.
    [
      "errors-only:budget",
      "a reply carrying `errorsOnly` beside `trimmed` and `paced`",
      {
        degraded: true,
        errorsOnly: true,
        trimmed: true,
        paced: true,
        reason: "budget",
      },
      "budget",
    ],
  ])(
    "posts `%s` for %s",
    async (value, _reply, body, reason) => {
      respond = acceptWith(body);

      const verdict = await verdictFor(endpoint);

      expect(verdict).toBe(`${DEGRADED_MESSAGE_PREFIX}${value}`);
      expect(parseDegradedMessage(verdict)).toBe("errors-only");
      expect(parseOveragePauseReason(verdict)).toBe(reason);
    },
    20_000,
  );

  /**
   * Every mode but `full`, named as `IngestMode` names them. A Record, so a
   * mode added there and not here fails to compile - and once added here, the
   * case below fails until the worker announces it too.
   */
  const readableModes: Record<Exclude<IngestMode, "full">, true> = {
    reduced: true,
    trimmed: true,
    paced: true,
    "errors-only": true,
  };

  it.each([
    ["with credentials", { appKey: "k", appSecret: "s" }],
    // A collector in placeholder mode takes unauthenticated batches and
    // answers them by the same rules, so they need the header just as much.
    ["without credentials", { appKey: undefined, appSecret: undefined }],
  ])(
    "lists the ingest modes it can read on a batch sent %s",
    async (_label, credentials) => {
      let received: IncomingMessage["headers"] | undefined;
      respond = (req, res) => {
        received = req.headers;
        acceptWith({ degraded: false })(req, res);
      };

      await verdictFor(endpoint, credentials);

      // The collector answers `paced` only to an agent that lists it here,
      // and answers the rest of a paced account's batches as undegraded -
      // and `errorsOnly` only to one that lists `errors-only`, answering the
      // rest of a paused account's batches `{ degraded: true }`.
      expect(received?.["x-observe-ingest-modes"]).toBe(
        Object.keys(readableModes).join(", "),
      );
      expect(received?.["x-api-key"]).toBe(credentials.appKey);
    },
    20_000,
  );

  /**
   * Every line the worker posts for one accepted batch, up to and including
   * its verdict - built from the real assembly, as `verdictFor` is.
   */
  const linesFor = async (asksForOtlpExport: boolean) => {
    const worker = new Worker(detachedWorkerSource(), {
      eval: true,
      workerData: detachedWorkerData({
        sharedBuffer: bufferWithBatch(JSON.stringify({ traces: [] })),
        endpoint,
        appKey: "k",
        appSecret: "s",
        flushInterval: 5000,
        asksForOtlpExport,
      }),
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const lines: string[] = [];
        const timer = setTimeout(
          () => reject(new Error("worker posted no verdict")),
          5_000,
        );
        worker.on("message", (msg: string) => {
          lines.push(msg);
          if (msg.startsWith(DEGRADED_MESSAGE_PREFIX)) {
            clearTimeout(timer);
            // A copy: the worker goes on posting until it is terminated.
            resolve([...lines]);
          }
        });
        worker.once("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    } finally {
      await worker.terminate();
    }
  };

  it("asks what the plan allows OTLP export only when it is set up to export", async () => {
    const modes: Array<string | string[] | undefined> = [];
    respond = (req, res) => {
      modes.push(req.headers["x-observe-ingest-modes"]);
      acceptWith({ degraded: false, otlpExport: "full" })(req, res);
    };

    const exporting = await linesFor(true);
    const plain = await linesFor(false);

    expect(modes).toEqual([
      `${Object.keys(readableModes).join(", ")}, ${OTLP_EXPORT_INGEST_MODE}`,
      Object.keys(readableModes).join(", "),
    ]);
    // Without it, the lines for a batch are what they always were.
    expect(plain).not.toContainEqual(
      expect.stringContaining(OTLP_EXPORT_MESSAGE_PREFIX),
    );
    expect(exporting).toContain(`${OTLP_EXPORT_MESSAGE_PREFIX}full`);
  }, 20_000);

  // The grant posted, the reply it is posted for, and that reply's body.
  it.each([
    ["full", "a paid plan's reply", { degraded: false, otlpExport: "full" }],
    ["capped", "Free's reply", { degraded: false, otlpExport: "capped" }],
    // Every reply says it again, the degraded ones too.
    [
      "capped",
      "a paced Free day's reply",
      { degraded: true, paced: true, otlpExport: "capped" },
    ],
    [
      "full",
      "a paused overage's reply",
      { degraded: true, errorsOnly: true, otlpExport: "full" },
    ],
    // A collector that predates export says nothing, which grants nothing.
    ["off", "a reply without a grant", { degraded: false }],
    ["off", "a reply with no body", undefined],
    ["off", "a grant this agent cannot read", { otlpExport: true }],
    ["off", "an unknown grant", { otlpExport: "unlimited" }],
  ])(
    "posts `%s` for %s, ahead of the verdict",
    async (grant, _reply, body) => {
      respond = acceptWith(body);

      const lines = await linesFor(true);

      expect(lines.slice(-2)).toEqual([
        `${OTLP_EXPORT_MESSAGE_PREFIX}${grant}`,
        expect.stringMatching(new RegExp(`^${DEGRADED_MESSAGE_PREFIX}`)),
      ]);
    },
    20_000,
  );

  it("names its own release on every batch", async () => {
    let received: IncomingMessage["headers"] | undefined;
    respond = (req, res) => {
      received = req.headers;
      acceptWith({ degraded: false })(req, res);
    };

    await verdictFor(endpoint, { appKey: "k", appSecret: "s" });

    // What the collector stores per application, so an app still running
    // an old release can be told a newer one exists.
    expect(received?.["x-observe-sdk-version"]).toBe(readSdkVersion());
    expect(received?.["x-observe-sdk-version"]).not.toBe(UNKNOWN_SDK_VERSION);
  }, 20_000);
});
