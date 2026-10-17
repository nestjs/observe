/**
 * How the detached worker tells the main thread that the collector is
 * accepting batches while discarding their spans.
 *
 * A string prefix rather than a structured message because the worker channel
 * is already strings - every other line it posts is human-readable prose the
 * parent logs - and a second message shape would have to be threaded through
 * the same handler anyway. Parsed in exactly one place on each side.
 *
 * The value after it is `false`, `true`, `trimmed`, `paced` or `errors-only` -
 * see `IngestMode` - and an `errors-only` value carries the pause's reason
 * after a colon when the collector gave one this agent can word:
 * `errors-only:spike` or `errors-only:budget` (see `OveragePauseReason`).
 */
export const DEGRADED_MESSAGE_PREFIX = "observe:degraded=";

/**
 * What the collector said it does with a batch's spans.
 *
 * - `full`: keeps them all.
 * - `reduced`: the account has used its monthly allowance - Free's reduced
 *   ingest - and only notable traces keep their spans.
 * - `trimmed`: a paying account past its threshold has its traces trimmed by
 *   the same rule, to keep its bill down.
 * - `paced`: a Free account still inside its allowance whose UTC day passed a
 *   tenth of it has its traces held back by the same rule until 00:00 UTC, so
 *   one busy day cannot spend the month.
 * - `errors-only`: a paying account's overage is paused - by spike protection,
 *   or because its monthly overage budget is spent - and the collector keeps
 *   its server errors (`isServerErrorSnapshot`) and nothing else: not their
 *   trees, no other request or job, no log record. Runtime and custom metrics
 *   and objectives are kept as ever.
 *
 * `reduced`, `trimmed` and `paced` withhold exactly the same trees; they
 * differ only in why, which is what the operator is told and what they can do
 * about it. `errors-only` withholds far more, and only the dashboard or the
 * turn of the month ends it.
 *
 * Every batch says which of them this agent can tell apart, in the request
 * header `x-observe-ingest-modes: reduced, trimmed, paced, errors-only` (set
 * where the worker builds its headers, credentials or not). The collector
 * reads only `paced` and `errors-only`. Agents up to 0.3.11 send no header and
 * take any `degraded: true` for a spent allowance, so a paced account's
 * batches from them are answered `{ degraded: false }` and the collector trims
 * the trees itself: the waterfalls are still held back, and nobody is told
 * their month is gone. Only an agent that lists `paced` is answered
 * `{ degraded: true, paced: true }`, and can stop sending those trees in the
 * first place.
 *
 * A paused account's batches are answered `{ degraded: true }` when the agent
 * does not list `errors-only`, as no agent up to 0.3.12 does, and the
 * collector keeps only the server errors of whatever arrives. Only an agent
 * that lists it is answered `{ degraded: true, errorsOnly: true, reason }`,
 * and can stop sending the rest - and say why.
 */
export type IngestMode =
  | "full"
  | "reduced"
  | "trimmed"
  | "paced"
  | "errors-only";

/**
 * Why a paying account's overage is paused, as an `errors-only` reply says
 * it: `spike` when spike protection paused it - a day far past the account's
 * usual volume, while it was already in overage - and `budget` when its
 * monthly overage budget is spent.
 *
 * Only the operator's notice reads it. What is withheld is the same either
 * way, and so is a reason this agent has no words for, or none at all.
 */
export type OveragePauseReason = "spike" | "budget";

/**
 * How long the main thread keeps withholding spans after the last batch that
 * reported degradation.
 *
 * The state is advisory and the collector never announces the end of it: an
 * upgrade, the turn of the billing period, an overage pause resumed in the
 * dashboard or, for a paced day, 00:00 UTC simply starts keeping spans again.
 * So it expires on its own, and the cost of it being briefly stale is one
 * flush of spans sent and discarded - against a restart being required to
 * recover, which is what a sticky flag would have cost.
 */
export const DEGRADED_TTL_MS = 5 * 60 * 1000;

/**
 * The worker's line for one batch, or null if this is not that line.
 *
 * `true` and `false` are what the line has always carried, and they mean what
 * they always did; `trimmed`, `paced` and `errors-only` are the additions. An
 * `errors-only` line reads as one whatever follows its colon: the reason only
 * words the notice (`parseOveragePauseReason`), and one this agent cannot word
 * must not send a paused account's every request. Anything else reads as
 * `full`, as every value but `true` always has.
 */
export function parseDegradedMessage(msg: string): IngestMode | null {
  if (!msg.startsWith(DEGRADED_MESSAGE_PREFIX)) {
    return null;
  }
  const value = msg.slice(DEGRADED_MESSAGE_PREFIX.length);
  switch (value) {
    case "true":
      return "reduced";
    case "trimmed":
      return "trimmed";
    case "paced":
      return "paced";
    case "errors-only":
      return "errors-only";
    default:
      return value.startsWith("errors-only:") ? "errors-only" : "full";
  }
}

/**
 * Why the worker's line says the account's overage is paused, or null when it
 * is not an `errors-only` line, or gives no reason, or one this agent has no
 * words for - read beside `parseDegradedMessage`, from the same line.
 */
export function parseOveragePauseReason(
  msg: string,
): OveragePauseReason | null {
  switch (msg) {
    case `${DEGRADED_MESSAGE_PREFIX}errors-only:spike`:
      return "spike";
    case `${DEGRADED_MESSAGE_PREFIX}errors-only:budget`:
      return "budget";
    default:
      return null;
  }
}

/**
 * How the detached worker tells the main thread it will send nothing until a
 * given time (epoch milliseconds): after a 429 or rejected credentials, until
 * that pause lapses.
 *
 * Only the final flush reads it. A paused worker leaves the shared slot
 * untouched, so without this a shutdown would wait out its whole deadline for
 * a batch that was never going to be sent.
 */
export const PAUSED_MESSAGE_PREFIX = "observe:paused-until=";

/** The time sends are paused until, or null if this is not that line. */
export function parsePausedMessage(msg: string): number | null {
  if (!msg.startsWith(PAUSED_MESSAGE_PREFIX)) {
    return null;
  }
  const until = Number(msg.slice(PAUSED_MESSAGE_PREFIX.length));
  return Number.isFinite(until) ? until : null;
}

/**
 * Duration past which the collector treats an execution as notable, in
 * milliseconds.
 *
 * Mirrors the collector's `NOTABLE_TRACE_DURATION_MS`. Duplicated because the
 * agent cannot reach the server's constants, and the cost of drift is bounded
 * and one-directional: too low here sends trees the collector discards, too
 * high withholds ones it would have kept.
 */
export const NOTABLE_DURATION_MS = 1_000;

const SERVER_ERROR_FLOOR = 500;

/**
 * Whether the collector would keep this execution's spans even while degraded.
 *
 * Degraded ingestion truncates ordinary traffic and keeps the executions worth
 * looking at. The agent has to make the same call before it withholds
 * anything, or an account past its allowance loses exactly the waterfalls the
 * collector was still willing to store - and loses them silently.
 *
 * A server error (`isServerErrorSnapshot`, whose rule this shares), or
 * anything slow.
 */
export function isNotableSnapshot(snapshot: {
  d?: number;
  e?: unknown;
  a?: { sc?: number };
}): boolean {
  const slow =
    typeof snapshot.d === "number" && snapshot.d > NOTABLE_DURATION_MS;
  return slow || isServerErrorSnapshot(snapshot);
}

/**
 * Whether an execution is a server error: what the collector still keeps of
 * an account whose overage is paused (`errors-only`), and half of what makes
 * an execution notable.
 *
 * Mirrors the collector's `isServerErrorExecution` - its notable rule without
 * the duration half - for the reason `isNotableSnapshot` mirrors the rest: an
 * agent that withholds what the collector would have kept loses a paused
 * account the one stream it was promised, and loses it silently. A slow
 * success is notable and still not one of these.
 *
 * The rule includes the part that looks wrong: where there is a status code
 * it decides alone, and the error object is not consulted beside it. An
 * expected 401 carries an error exactly like a 500 does, and on that platform
 * 401s and 429s are most of the daily error count - so consulting the error
 * first would send a tree for every unauthenticated probe, which is the
 * traffic degraded ingest exists to stop sending, and would keep every one of
 * them through a pause, when a 4xx flood is a common cause of the spike.
 */
export function isServerErrorSnapshot(snapshot: {
  e?: unknown;
  a?: { sc?: number };
}): boolean {
  const statusCode = snapshot.a?.sc;

  if (typeof statusCode === "number") {
    return statusCode >= SERVER_ERROR_FLOOR;
  }

  // No status code: a job, or a non-HTTP entry point. Nothing grades these but
  // the error, so here it is the signal rather than the noise.
  return Boolean(snapshot.e);
}

/**
 * Nodes in an encoded trace tree, counted the way the collector counts them.
 *
 * Every node, children included - which is what the meter bills and what the
 * collector's own `countTraceNodes` walks. Counting roots instead would report
 * a fraction of what was withheld and measure the account against the wrong
 * volume; on an auto-instrumented request, where a single root routinely
 * carries eighty-odd children, it would be off by roughly that factor.
 *
 * Children live under `ch`, matching the encoded shape the collector parses.
 */
export function countTraceNodes(traces: unknown): number {
  if (!Array.isArray(traces)) {
    return 0;
  }

  let count = 0;
  for (const node of traces) {
    count += 1;
    count += countTraceNodes((node as { ch?: unknown } | null)?.ch);
  }
  return count;
}
