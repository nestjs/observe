import { INestApplication, INestMicroservice } from "@nestjs/common";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { JobSnapshot } from "../interfaces/job-snapshot.interface.js";
import { ObserveOptions } from "../interfaces/observe-options.interface.js";
import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";

/**
 * Module options every protocol suite boots with.
 *
 * Credentials are required by the options contract but never used here:
 * snapshots are intercepted before they reach the buffer, so the worker finds
 * nothing to flush and never contacts a collector. The long flush interval is
 * belt and braces - it guarantees the timer cannot fire mid-suite even if a
 * future change starts letting data through.
 */
export function testObserveOptions(
  overrides: Partial<ObserveOptions> = {},
): ObserveOptions {
  return {
    appKey: "test-app-key",
    appSecret: "test-app-secret",
    serviceId: "00000000-0000-4000-8000-000000000000",
    runtimeMetrics: false,
    forwardLogs: false,
    flushInterval: 60_000,
    ...overrides,
  };
}

/**
 * Shared plumbing for the protocol integration suites.
 *
 * `ObserveModule` is destined to be its own npm package, so these suites boot
 * real Nest applications and drive real traffic through them rather than
 * calling the agents directly - the thing worth protecting is that the module
 * still attaches to Nest's hooks, and only a real app exercises that.
 *
 * Snapshots are captured at `ObserveAgentSharedBuffer.insertRequestSnapshot`,
 * which is where every protocol converges once a trace completes. Asserting
 * there rather than on the encoded payload keeps the tests about *what was
 * collected* instead of how it is serialised.
 */
export class CollectedSnapshots {
  readonly items: RequestSnapshot[] = [];

  get operationIds(): Array<string | undefined> {
    return this.items.map((snapshot) => snapshot.operationId);
  }

  find(operationId: string): RequestSnapshot | undefined {
    return this.items.find((snapshot) => snapshot.operationId === operationId);
  }

  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Intercepts snapshots on their way into the shared buffer.
 *
 * Spied rather than read back out of the buffer: the buffer encodes into a
 * `SharedArrayBuffer` and is drained by a worker thread on a timer, so reading
 * it would make every assertion a race.
 */
export function collectSnapshots(
  app: INestApplication | INestMicroservice,
): CollectedSnapshots {
  const collected = new CollectedSnapshots();
  const buffer = app.get(ObserveAgentSharedBuffer, { strict: false });

  vi.spyOn(buffer, "insertRequestSnapshot").mockImplementation(
    (snapshot: RequestSnapshot) => {
      collected.items.push(snapshot);
    },
  );

  return collected;
}

/**
 * Waits for a snapshot to arrive, or gives up.
 *
 * Every protocol finishes its trace asynchronously - the HTTP agent after the
 * response hook, gRPC after the call ends - so a bare assertion after
 * `await request(...)` is a race the test would lose intermittently. Polling to
 * a deadline keeps the suites honest about that without hard-coded sleeps.
 */
export async function waitForSnapshot(
  collected: CollectedSnapshots,
  predicate: (snapshot: RequestSnapshot) => boolean,
  timeoutMs = 3000,
): Promise<RequestSnapshot> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = collected.items.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `No matching snapshot within ${timeoutMs}ms. Collected: ${JSON.stringify(
      collected.items.map((s) => ({
        protocol: s.protocol,
        operationId: s.operationId,
      })),
    )}`,
  );
}

/**
 * The job-shaped counterpart of `CollectedSnapshots`, for the handlers that run
 * from a timer or a queue rather than a request.
 */
export class CollectedJobSnapshots {
  readonly items: JobSnapshot[] = [];

  find(name: string): JobSnapshot | undefined {
    return this.items.find((snapshot) => snapshot.name === name);
  }

  clear(): void {
    this.items.length = 0;
  }
}

/** Intercepts job snapshots at `ObserveAgentSharedBuffer.insertJobSnapshot`. */
export function collectJobSnapshots(
  app: INestApplication | INestMicroservice,
): CollectedJobSnapshots {
  const collected = new CollectedJobSnapshots();
  const buffer = app.get(ObserveAgentSharedBuffer, { strict: false });

  vi.spyOn(buffer, "insertJobSnapshot").mockImplementation(
    (snapshot: JobSnapshot) => {
      collected.items.push(snapshot);
    },
  );

  return collected;
}

export async function waitForJobSnapshot(
  collected: CollectedJobSnapshots,
  predicate: (snapshot: JobSnapshot) => boolean,
  timeoutMs = 3000,
): Promise<JobSnapshot> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = collected.items.find(predicate);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `No matching job snapshot within ${timeoutMs}ms. Collected: ${JSON.stringify(
      collected.items.map((s) => ({
        queueName: s.queueName,
        name: s.name,
        status: s.status,
      })),
    )}`,
  );
}

/** Polls `condition` to a deadline; throws, naming `what`, if it never holds. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
}

export interface CapturedOutput {
  /** Every chunk written to stdout or stderr since the capture began. */
  readonly lines: string[];
  /** Puts the original stream methods back. */
  restore(): void;
}

/**
 * Records what the process writes to stdout and stderr, from now until
 * `restore`.
 *
 * Both streams, and only the streams: Nest's `ConsoleLogger` writes straight
 * to them - errors to stderr, everything else to stdout - and never through
 * `console.*`, so a patched console sees nothing of what the agent logs.
 * Restored explicitly rather than left for process exit: the int suites run
 * one file per process, but a wrapper left in place would stack under the
 * next capture in the same file and record every line twice.
 */
export function captureOutput(): CapturedOutput {
  const lines: string[] = [];
  const restores: Array<() => void> = [];

  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write;
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return Reflect.apply(original, stream, [chunk, ...rest]);
    }) as typeof stream.write;
    restores.push(() => {
      stream.write = original;
    });
  }

  return {
    lines,
    restore: () => {
      for (const restore of restores) {
        restore();
      }
    },
  };
}

/** A free port, so parallel suites and a busy machine cannot collide. */
export async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Listens on 127.0.0.1, on a port the OS picks for that address, and returns
 * the base URL - for a suite whose clients connect to 127.0.0.1.
 *
 * Not a port from `freePort` and a bind to every interface: on macOS such a
 * bind can be given a port that another process already holds on 127.0.0.1
 * alone - a stray `redis-server` from someone's test run, say - and a client
 * dialling 127.0.0.1 then reaches that process and gets `socket hang up`.
 * supertest's own `listen(0)` on an unlistened app has the same exposure.
 */
export async function listenOnLoopback(
  target: INestApplication | Server,
): Promise<string> {
  let server: Server;
  if ("getHttpServer" in target) {
    await target.listen(0, "127.0.0.1");
    server = target.getHttpServer() as Server;
  } else {
    server = target;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
  }
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
