import { Worker } from "worker_threads";
import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { createServer as createNetServer, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  detachedWorkerData,
  detachedWorkerSource,
} from "./detached-observe-worker.assembly.js";

const SENT = "Tracing and instrumentation data sent successfully";

/**
 * Writes one batch into the shared buffer the way the main thread does:
 * under the lock, bytes first and the length last.
 */
const writeBatch = (sharedBuffer: SharedArrayBuffer, json: string) => {
  const lock = new Int32Array(sharedBuffer, 0, 1);
  while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) {
    Atomics.wait(lock, 0, 1, 10);
  }
  try {
    const encoded = new TextEncoder().encode(json);
    new Uint8Array(sharedBuffer).set(encoded, 8);
    new DataView(sharedBuffer, 4, 4).setUint32(0, encoded.length);
  } finally {
    Atomics.store(lock, 0, 0);
    Atomics.notify(lock, 0);
  }
};

/**
 * Starts the worker from the same source and data `ObserveAgentWorker` uses
 * (see worker-failure-reporting.spec.ts for why not a copy), and resolves
 * `sends(n)` once it has reported n successful sends. Any error the worker
 * reports fails the wait - a retried batch must not surface as one.
 */
const startWorker = (endpoint: string, bufferSize = 64 * 1024) => {
  const sharedBuffer = new SharedArrayBuffer(bufferSize);
  const worker = new Worker(detachedWorkerSource(), {
    eval: true,
    workerData: detachedWorkerData({
      sharedBuffer,
      endpoint,
      appKey: "k",
      appSecret: "s",
      flushInterval: 5000,
    }),
  });

  let sent = 0;
  let failure: string | undefined;
  const waiters: Array<() => void> = [];
  worker.on("message", (msg: string) => {
    if (msg === SENT) {
      sent += 1;
    } else if (msg.startsWith("Error:")) {
      failure = msg;
    }
    waiters.splice(0).forEach((wake) => wake());
  });

  const sends = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`worker reported ${sent} of ${count} sends`)),
        10_000,
      );
      const check = () => {
        if (failure) {
          clearTimeout(timer);
          reject(new Error(failure));
        } else if (sent >= count) {
          clearTimeout(timer);
          resolve();
        } else {
          waiters.push(check);
        }
      };
      check();
    });

  return {
    send: (batch: unknown) => writeBatch(sharedBuffer, JSON.stringify(batch)),
    sends,
    stop: () => worker.terminate(),
  };
};

/**
 * Accepts a batch and answers the way the hosted collector's load balancer
 * does: `Connection: keep-alive` and no `Keep-Alive: timeout` hint. Setting
 * the header by hand stops Node adding its own hint, and without one the
 * idle timeout is the client's to choose - which is where `fetch` chose 4 s.
 */
const accept = (req: IncomingMessage, res: ServerResponse) => {
  req.resume();
  req.on("end", () => {
    res.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive",
    });
    res.end(JSON.stringify({ degraded: false }));
  });
};

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the detached worker's connection to the collector", () => {
  let collector: Server | undefined;
  let worker: ReturnType<typeof startWorker> | undefined;

  afterEach(async () => {
    await worker?.stop();
    await new Promise<void>((resolve) =>
      collector ? collector.close(() => resolve()) : resolve(),
    );
    collector = worker = undefined;
  });

  it("sends successive batches over one connection, idle gaps included", async () => {
    let connections = 0;
    collector = createServer(accept);
    // Keeps idle connections as long as a load balancer does (an ALB defaults
    // to 60 s), rather than Node's 5 s.
    collector.keepAliveTimeout = 60_000;
    collector.on("connection", () => (connections += 1));
    worker = startWorker(await listen(collector));

    worker.send({ traces: [] });
    await worker.sends(1);
    // Past the 4 s after which `fetch`'s agent dropped an idle socket - the
    // gap every default 5 s flush left - so this is the case that used to
    // cost a new connection per batch.
    await sleep(4_500);
    worker.send({ traces: [] });
    await worker.sends(2);

    expect(connections).toBe(1);
  }, 20_000);

  it("resends a batch once when the collector dropped the kept-alive connection under it", async () => {
    let connections = 0;
    let requests = 0;
    const served = new WeakMap<Socket, number>();
    collector = createServer((req, res) => {
      requests += 1;
      const before = served.get(req.socket) ?? 0;
      served.set(req.socket, before + 1);
      if (before > 0) {
        // What a server closing an idle connection looks like from the
        // client: the reused socket dies with the batch unread and unanswered.
        req.socket.destroy();
        return;
      }
      accept(req, res);
    });
    collector.keepAliveTimeout = 60_000;
    collector.on("connection", () => (connections += 1));
    worker = startWorker(await listen(collector));

    worker.send({ traces: [] });
    await worker.sends(1);
    worker.send({ traces: [] });
    await worker.sends(2);

    expect(requests).toBe(3);
    expect(connections).toBe(2);
  }, 20_000);

  // The reply is held, decoded and parsed in the application's process:
  // without a limit its size, and many times that once parsed, would be the
  // sender's to choose.
  it("stops reading a reply past 64 KiB, and still acts on its status", async () => {
    let written = 0;
    collector = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(16 * 1024, " ");
        const more = () => {
          // A reply that never ends; it stops only when the worker hangs up.
          while (!res.destroyed && res.write(chunk)) {
            written += chunk.length;
            if (written > 8 * 1024 * 1024) {
              return;
            }
          }
          res.once("drain", more);
        };
        more();
      });
    });
    worker = startWorker(await listen(collector));

    worker.send({ traces: [] });
    await worker.sends(1);

    expect(written).toBeLessThan(8 * 1024 * 1024);
  }, 20_000);

  // A collector that answers off the head of a batch and stops reading: the
  // send is over, but the upload never finishes, and a socket nobody pools
  // or times out any more would stay open, one more per flush.
  it("lets go of the connection when the reply ends before the batch is written", async () => {
    let closed = false;
    let socket: Socket | undefined;
    const early = createNetServer((connection) => {
      socket = connection;
      connection.once("data", () => {
        connection.pause();
        connection.write(
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n" +
            "Connection: keep-alive\r\nContent-Length: 2\r\n\r\n{}",
        );
      });
      connection.on("error", () => undefined);
      connection.on("close", () => (closed = true));
      connection.on("end", () => (closed = true));
    });
    await new Promise<void>((resolve) => early.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = early.address() as { port: number };
      worker = startWorker(`http://127.0.0.1:${port}`, 8 * 1024 * 1024);
      // Too much for the kernel to take unread, gzipped or not.
      worker.send({
        traces: [randomBytes(4 * 1024 * 1024).toString("base64")],
      });
      await worker.sends(1);

      // Read now: a released request comes to its end, a held one waits.
      await sleep(200);
      socket!.resume();
      const isClosed = () => closed;
      for (let waited = 0; !isClosed() && waited < 3_000; waited += 50) {
        await sleep(50);
      }
      expect(closed).toBe(true);
    } finally {
      socket?.destroy();
      await new Promise((resolve) => early.close(resolve));
    }
  }, 20_000);
});
