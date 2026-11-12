/**
 * Whether the operation an async store was opened for is still running, for
 * whatever hands the store's trace id on.
 *
 * A store outlives its operation: Node hands it to every timer, socket and
 * listener created while the operation ran, and every span runs in a copy of
 * it. Nothing said the operation was over, so a flush or retry interval a
 * request armed lazily went on labelling everything it did - its outgoing
 * calls' `x-request-id`, its log lines, `currentTraceId()` - with that
 * request's id for the life of the process, and every service it called
 * merged unrelated work into one old trace.
 *
 * Read with a grace period rather than cut at the end: work an operation
 * leaves running when it ends - an email sent after the response, a late log
 * line - still belongs to it, and keeps its id for `OPERATION_GRACE_MS`. Only
 * what runs on past that loses it.
 */

/** Where an operation's state sits in its store. */
export const OPERATION_STATE_KEY = "#operation";

/** How long after its operation ended a store still hands its trace id on. */
export const OPERATION_GRACE_MS = 10_000;

/**
 * One per operation, shared by reference: the copies of the store that spans
 * run in hold the same object, so ending it reaches them all.
 */
export interface OperationState {
  /** `performance.now()` when the operation ended; absent while it runs. */
  endedAt?: number;
}

/** Marks `store` as opened for an operation now starting. */
export function openOperation(store: Map<any, any>): OperationState {
  const state: OperationState = {};
  store.set(OPERATION_STATE_KEY, state);
  return state;
}

/** Marks an operation as ended. Only the first end counts. */
export function endOperation(state: OperationState | undefined): void {
  if (state !== undefined && state.endedAt === undefined) {
    state.endedAt = performance.now();
  }
}

/**
 * The trace id `store` holds under `traceIdKey`, while its operation runs and
 * for the grace period after - undefined past that, as outside any operation.
 * A store opened before operations were marked counts as running.
 */
export function liveTraceId(
  store: Map<any, any> | undefined,
  traceIdKey: string,
): string | undefined {
  const traceId: unknown = store?.get(traceIdKey);
  if (typeof traceId !== "string") {
    return undefined;
  }
  const endedAt = (
    store!.get(OPERATION_STATE_KEY) as OperationState | undefined
  )?.endedAt;
  if (
    endedAt !== undefined &&
    performance.now() - endedAt > OPERATION_GRACE_MS
  ) {
    return undefined;
  }
  return traceId;
}
