import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { Worker } from "worker_threads";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freePort } from "../testing/observe-harness.js";
import {
  DEGRADED_MESSAGE_PREFIX,
  NOT_INGESTED_MESSAGE_PREFIX,
} from "./degraded-ingest.protocol.js";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";

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
 * Runs the worker over one batch until it says whether the batch got in: its
 * degraded verdict when it did, its not-ingested line when it did not.
 *
 * Assembled from the same source and data as `ObserveAgentWorker` uses, so a
 * prefix the real assembly forgets to pass is missing here too.
 */
const outcomeOf = async (endpoint: string) => {
  const worker = new Worker(detachedWorkerSource(), {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer: bufferWithBatch(JSON.stringify({ traces: [] })),
      endpoint,
      appKey: "k",
      appSecret: "s",
      flushInterval: 5000,
    }),
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("worker said nothing about the batch")),
        5_000,
      );
      worker.on("message", (msg: string) => {
        if (
          msg.startsWith(NOT_INGESTED_MESSAGE_PREFIX) ||
          msg.startsWith(DEGRADED_MESSAGE_PREFIX)
        ) {
          clearTimeout(timer);
          resolve(msg);
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

/** Reads the request, then answers with the given status and JSON body. */
const answer =
  (status: number, body: unknown = {}): Respond =>
  (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  };

/**
 * What the worker tells the main thread about each batch it sends, which
 * OpenTelemetry interop runs on: a refusal of the credentials apart from
 * every other way a batch fails to get in.
 */
describe("whether the detached worker's batch got in", () => {
  let collector: Server;
  let endpoint: string;
  let respond: Respond = answer(200);

  beforeAll(async () => {
    collector = createServer((req, res) => respond(req, res));
    await new Promise<void>((resolve) =>
      collector.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    collector.closeAllConnections();
    await new Promise<void>((resolve) => collector.close(() => resolve()));
  });

  it("says a batch the collector accepted got in", async () => {
    respond = answer(200, { degraded: false });

    expect(await outcomeOf(endpoint)).toBe(`${DEGRADED_MESSAGE_PREFIX}false`);
  }, 20_000);

  it.each([401, 403])(
    "says the credentials were refused on a %d",
    async (status) => {
      respond = answer(status, { message: "Unauthorized" });

      expect(await outcomeOf(endpoint)).toBe(
        `${NOT_INGESTED_MESSAGE_PREFIX}refused`,
      );
    },
    20_000,
  );

  it.each([429, 500, 503])(
    "says the batch failed to get in on a %d",
    async (status) => {
      respond = answer(status, { message: "nope" });

      expect(await outcomeOf(endpoint)).toBe(
        `${NOT_INGESTED_MESSAGE_PREFIX}failed`,
      );
    },
    20_000,
  );

  it("says the batch failed to get in when the collector is unreachable", async () => {
    const port = await freePort();

    expect(await outcomeOf(`http://127.0.0.1:${port}`)).toBe(
      `${NOT_INGESTED_MESSAGE_PREFIX}failed`,
    );
  }, 20_000);
});
