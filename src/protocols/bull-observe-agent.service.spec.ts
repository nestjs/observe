import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { BullObserveAgentService } from "./bull-observe-agent.service.js";
import { JobTraceRunner } from "./job-trace-runner.js";

/**
 * The Bull suites need Redis; what the agent reads off a job before handing
 * it to the processor does not, so it is driven here through the wrapper the
 * agent puts around a processor.
 */
describe("BullObserveAgentService", () => {
  const instrument = (handler: (job: unknown) => unknown) => {
    const als = new AsyncLocalStorage<Map<string, unknown>>();
    const agent = new BullObserveAgentService(
      { insertJobSnapshot: vi.fn() } as never,
      { traceIdKey: "traceId" } as never,
      new OperationTraceRegistry(als as never, false),
      als as never,
    );
    return (
      agent as unknown as {
        instrument: (handler: unknown) => (job: unknown) => unknown;
      }
    ).instrument(handler);
  };

  it.each([
    ["a timestamp past what a Date holds", { timestamp: 8.64e15 + 1 }],
    ["a timestamp that is no number", { timestamp: Number.NaN }],
    [
      "a delay option that is an object",
      { timestamp: 1_700_000_000_000, opts: { delay: { toString: 1 } } },
    ],
  ])("still runs a job with %s", async (_, fields) => {
    // Formatting the job's times threw before the processor was called, and
    // Bull failed a job that completes without the agent.
    const processor = vi.fn(async (_job: unknown) => "done");

    await expect(
      instrument(processor)({
        queue: { name: "emails" },
        name: "welcome",
        id: 1,
        ...fields,
      }),
    ).resolves.toBe("done");
    expect(processor).toHaveBeenCalledOnce();
  });

  /** The timeout the agent hands the runner for a job's `timeout` option. */
  const timeoutHandedOnFor = (timeout: unknown) => {
    const run = vi
      .spyOn(JobTraceRunner.prototype, "run")
      .mockImplementation(() => undefined);
    void instrument(async () => undefined)({
      queue: { name: "previews" },
      name: "download",
      id: 1,
      opts: { timeout },
    });
    return run.mock.calls[0][0].timeout;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    // Bull arms no timer for these.
    [undefined, undefined],
    [0, undefined],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [100, 100],
    // And fails the job as soon as the handler returns for these.
    [-1, 0],
    ["50", 0],
    // A timer past what Node holds fires after 1 ms.
    [2 ** 31, 1],
  ])("ends a job with a timeout of %s as Bull does: %s", (timeout, ms) => {
    expect(timeoutHandedOnFor(timeout)).toBe(ms);
  });
});
