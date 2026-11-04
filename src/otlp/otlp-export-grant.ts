/**
 * What the collector says an app's plan allows `otlp` to export - read off
 * the reply to an accepted batch, so the plans live where they are sold and
 * this agent names none of them:
 *
 * - `full`: every operation the agent records, with its whole tree, ahead of
 *   anything the collector's answers make it hold back from NestJS Observe -
 *   an account paused for its overage still exports every trace.
 * - `capped`: what NestJS Observe keeps of it and nothing more. Whatever this
 *   agent leaves out of a batch is left out of the export, and an operation
 *   it sends without its spans - a day past Free's daily pacing, an account
 *   past its monthly allowance - is exported as the operation's own span,
 *   without the tree under it.
 * - `off`: nothing. What a reply carrying no grant means, which is every
 *   reply from a collector that predates export, so an agent released before
 *   the collector learnt to answer exports nothing.
 */
export type OtlpExportGrant = "full" | "capped" | "off";

/**
 * The token an agent with `otlp` set adds to `x-observe-ingest-modes`, the
 * header in which it lists the answers it can read. The collector answers
 * `otlpExport` only to a batch that lists it, so the replies every other
 * agent gets stay what they were, byte for byte.
 */
export const OTLP_EXPORT_INGEST_MODE = "otlp-export";

/**
 * How the detached worker tells the main thread what the collector granted:
 * this prefix, then `full`, `capped` or `off`. Posted for every accepted
 * batch, ahead of the degraded verdict for the same batch, and only by a
 * worker that listed `OTLP_EXPORT_INGEST_MODE`.
 */
export const OTLP_EXPORT_MESSAGE_PREFIX = "observe:otlp-export=";

/** The grant a worker's line carries, or null if this is not that line. */
export function parseOtlpExportMessage(msg: string): OtlpExportGrant | null {
  if (!msg.startsWith(OTLP_EXPORT_MESSAGE_PREFIX)) {
    return null;
  }
  const value = msg.slice(OTLP_EXPORT_MESSAGE_PREFIX.length);
  return value === "full" || value === "capped" ? value : "off";
}
