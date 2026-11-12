import { AsyncLocalStorage } from "async_hooks";
import { OperationTraceRegistry } from "../services/operation-trace.registry.js";
import { BullObserveAgentService } from "./bull-observe-agent.service.js";

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
});
