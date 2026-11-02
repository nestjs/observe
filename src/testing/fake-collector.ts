import {
  createServer,
  IncomingHttpHeaders,
  Server,
  ServerResponse,
} from "node:http";
import { gunzipSync } from "node:zlib";
import { validateTelemetryPayload } from "../agent/telemetry-wire-contract.js";
import { listenOnLoopback, waitFor } from "./observe-harness.js";

/** A span as the encoders put it on the wire. */
export interface WireSpan {
  /** Class name. */
  c?: string;
  /** Method name. */
  m?: string;
  ch?: WireSpan[];
  [key: string]: unknown;
}

/** A request snapshot as the encoders put it on the wire. */
export interface WireSnapshot {
  ti: string;
  op?: string;
  p?: string;
  a?: { m?: string; sc?: number; ou?: string; dop?: string };
  t?: WireSpan[];
  [key: string]: unknown;
}

/** One handler's `@Objective` declarations, as the batch root carries them. */
export interface WireObjectiveDeclaration {
  handler: string;
  operationId: string;
  method?: string;
  objectives: Array<Record<string, unknown>>;
}

/** A batch body as the collector sees it, once gunzipped and parsed. */
export interface ReceivedBatch {
  serviceId: string;
  serviceVersion?: string;
  truncatedSpans?: number;
  snapshots?: WireSnapshot[];
  objectives?: WireObjectiveDeclaration[];
  [key: string]: unknown;
}

/** One request as it reached the collector, whatever it carried. */
export interface ReceivedRequest {
  /** When it arrived, epoch ms. */
  readonly at: number;
  /** As Node parsed them: names lower-cased. */
  readonly headers: IncomingHttpHeaders;
}

export interface FakeCollector {
  /** What to hand the module as `endpoint`. */
  readonly url: string;
  /** Every batch received, in order of arrival. */
  readonly batches: ReceivedBatch[];
  /**
   * Every request received, in order of arrival - refused ones, and ones
   * whose body did not parse, included.
   */
  readonly requests: ReceivedRequest[];
  /**
   * What `validateTelemetryPayload(batch, { forbidUnknown: true })` found
   * wrong with any batch received so far - the API validates with
   * `forbidNonWhitelisted`, so any entry here is a batch it would refuse.
   */
  readonly violations: string[];
  /** Every declaration received, in order of arrival. */
  declarations(): WireObjectiveDeclaration[];
  /** The batch that carried the snapshot with this trace id, if one did. */
  batchCarrying(traceId: string): ReceivedBatch | undefined;
  /** Waits for the batch carrying the snapshot with this trace id. */
  waitForTrace(traceId: string, timeoutMs?: number): Promise<ReceivedBatch>;
  /**
   * How every later batch is answered: `200` with `{}` until changed, plus
   * any headers given - a `Retry-After`, say. The batch is recorded whatever
   * the answer - a refused one was still sent.
   */
  answerWith(
    body: Record<string, unknown>,
    status?: number,
    headers?: Record<string, string>,
  ): void;
  /**
   * Leaves every answer open until `release` is called. The worker holds the
   * shared buffer's lock for as long as its send is open, so while a batch
   * waits here the main thread's flushes are skipped and whatever the
   * application records meanwhile piles up for one later batch: a slow
   * collector, on demand.
   */
  holdAnswers(): { release(): void };
  close(): Promise<void>;
}

/**
 * A collector on a free local port that records every batch the agent's
 * worker posts to it - gunzipped, parsed and checked against the wire
 * contract - so a suite can assert on what actually left the process rather
 * than on what was put into the shared buffer.
 */
export async function startFakeCollector(): Promise<FakeCollector> {
  const batches: ReceivedBatch[] = [];
  const requests: ReceivedRequest[] = [];
  const violations: string[] = [];
  let answer: {
    status: number;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  } = {
    status: 200,
    body: {},
    headers: {},
  };
  let held: Array<() => void> | null = null;

  const respond = (res: ServerResponse, reply: typeof answer) => {
    const send = () => {
      res.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      res.end(JSON.stringify(reply.body));
    };
    if (held) {
      held.push(send);
    } else {
      send();
    }
  };

  const server: Server = createServer((req, res) => {
    requests.push({ at: Date.now(), headers: req.headers });
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let batch: ReceivedBatch;
      try {
        batch = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString());
      } catch {
        // Only a send cut off by a worker terminated mid-flight - an app
        // closing - produces a body that does not parse. Nothing to record.
        res.writeHead(400).end();
        return;
      }
      const errors = validateTelemetryPayload(batch, { forbidUnknown: true });
      violations.push(
        ...errors.map((error) => `batch ${batches.length}: ${error}`),
      );
      batches.push(batch);
      respond(res, answer);
    });
  });

  // A port the OS picks as it binds: one from `freePort`, released before
  // the bind, can meanwhile become the local port of a connection the suite
  // opens, and the bind then fails with EADDRINUSE.
  const url = await listenOnLoopback(server);

  const batchCarrying = (traceId: string) =>
    batches.find((batch) =>
      (batch.snapshots ?? []).some((snapshot) => snapshot.ti === traceId),
    );

  return {
    url,
    batches,
    requests,
    violations,
    declarations: () => batches.flatMap((batch) => batch.objectives ?? []),
    batchCarrying,
    async waitForTrace(traceId, timeoutMs = 8_000) {
      await waitFor(
        () => batchCarrying(traceId) !== undefined,
        timeoutMs,
        `the batch carrying "${traceId}" to reach the collector`,
      );
      return batchCarrying(traceId)!;
    },
    answerWith(body, status = 200, headers = {}) {
      answer = { status, body, headers };
    },
    holdAnswers() {
      const pending: Array<() => void> = [];
      held = pending;
      return {
        release() {
          if (held === pending) {
            held = null;
          }
          for (const send of pending.splice(0)) {
            send();
          }
        },
      };
    },
    async close() {
      if (held) {
        for (const send of held.splice(0)) {
          send();
        }
        held = null;
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
