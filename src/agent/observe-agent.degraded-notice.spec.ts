import { afterEach, describe, expect, it, vi } from "vitest";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/observe-options.interface.js";
import { NodeRuntimeMetricsService } from "../services/node-runtime-metrics.service.js";
import { DEGRADED_MESSAGE_PREFIX } from "./degraded-ingest.protocol.js";
import { ObserveAgentSharedBuffer } from "./observe-agent.shared-buffer.js";
import { ObserveAgentWorker } from "./observe-agent.worker.js";

/** The worker's line for one batch, as detached-observe-worker.ts posts it. */
const verdict = (
  value:
    | "true"
    | "false"
    | "trimmed"
    | "paced"
    | "errors-only"
    | "errors-only:spike"
    | "errors-only:budget",
) => `${DEGRADED_MESSAGE_PREFIX}${value}`;

const REDUCED_NOTICE =
  "Observe: this account has used its monthly allowance, so most traces now arrive without their spans. " +
  "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
  "See /dashboard/billing/usage.";

const TRIMMED_NOTICE =
  "Observe: traces are now trimmed past this account's threshold to keep its bill down. " +
  "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
  'To keep every trace, turn on "Keep full traces" at /dashboard/billing/usage.';

const PACED_NOTICE =
  "Observe: this account's day passed the Free plan's daily limit, so most traces arrive without their spans until 00:00 UTC. " +
  "Requests, jobs and errors are still recorded, and server errors, slow requests and failed jobs keep their full traces. " +
  "See /dashboard/billing/usage.";

const RECOVERED_NOTICE = "Observe: spans are being recorded again.";

/** What every errors-only line says after its first sentence, the lift aside. */
const ERRORS_ONLY_KEPT =
  "Only server errors and failed jobs are sent now, without their spans; " +
  "every other request and job, and every log line, is held back. Runtime and custom metrics are still recorded. ";

const SPIKE_NOTICE =
  "Observe: spike protection paused this account's overage. " +
  ERRORS_ONLY_KEPT +
  "Full collection returns when someone resumes it at /dashboard/billing/usage, or at 00:00 UTC on the 1st.";

const BUDGET_NOTICE =
  "Observe: this account's monthly overage budget is spent, so its overage is paused. " +
  ERRORS_ONLY_KEPT +
  "Full collection returns when someone resumes it or raises the budget at /dashboard/billing/usage, or at 00:00 UTC on the 1st.";

const PAUSED_NOTICE =
  "Observe: this account's overage is paused. " +
  ERRORS_ONLY_KEPT +
  "Full collection returns when someone resumes it at /dashboard/billing/usage, or at 00:00 UTC on the 1st.";

const UNPAUSED_NOTICE =
  "Observe: this account's overage is no longer paused, so everything is recorded again.";

/**
 * What the agent tells the operator when the collector starts, changes or
 * stops withholding spans.
 *
 * Driven through `handleMessage`, where every line from the worker arrives,
 * with no thread behind it: worker-degraded-reply.spec.ts covers the other
 * half, from the collector's reply to the line.
 */
describe("ObserveAgentWorker's notice while spans are withheld", () => {
  const boot = () => {
    const options = {
      serviceId: "svc",
      appKey: "k",
      appSecret: "s",
      runtimeMetrics: false,
    } as ObserveModuleOptionsWithDefaults;
    const buffer = new ObserveAgentSharedBuffer(options);
    // Never started, so nothing reads the metrics service.
    const agent = new ObserveAgentWorker(
      buffer,
      options,
      {} as NodeRuntimeMetricsService,
    );
    const { logger } = agent as unknown as {
      logger: { warn: () => void; log: () => void };
    };
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);
    return { agent, buffer, warn, log };
  };

  /** Several batches in a row, as an account in one state for days sends. */
  const batches = (agent: ObserveAgentWorker, line: string, count = 3) => {
    for (let i = 0; i < count; i++) {
      agent.handleMessage(line);
    }
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tells an account out of its allowance what is still kept, once", () => {
    const { agent, buffer, warn, log } = boot();

    // What an older collector sends: `degraded`, and no `trimmed`.
    batches(agent, verdict("true"));

    expect(warn.mock.calls).toEqual([[REDUCED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(true);
  });

  it("tells a trimmed account why, and how to keep every trace, once", () => {
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("trimmed"));

    expect(warn.mock.calls).toEqual([[TRIMMED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    // Trimming withholds exactly the trees reduced ingest does.
    expect(buffer.isDegraded()).toBe(true);
  });

  it("tells a paced Free account its spans come back at 00:00 UTC, once", () => {
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("paced"));

    // Not the reduced line, which is what 0.3.11 said: a paced account is
    // inside its allowance, and its spans come back at midnight on their own.
    expect(warn.mock.calls).toEqual([[PACED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    // Pacing withholds exactly the trees reduced ingest does.
    expect(buffer.isDegraded()).toBe(true);
  });

  it.each(["true", "trimmed", "paced"] as const)(
    "says spans are recorded again when `%s` gives way to full ingest",
    (value) => {
      const { agent, buffer, log } = boot();
      agent.handleMessage(verdict(value));

      batches(agent, verdict("false"));

      expect(log.mock.calls).toEqual([[RECOVERED_NOTICE]]);
      expect(buffer.isDegraded()).toBe(false);
    },
  );

  it("says nothing while every span is kept", () => {
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("false"));

    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(false);
  });

  it("speaks again when the reason changes, not otherwise", () => {
    /*
     * A Pro account that cancels goes from trimmed to Free's reduced ingest:
     * the same trees are withheld throughout, but why, and what the operator
     * can do about it, are not the same.
     */
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("trimmed"));
    batches(agent, verdict("true"));
    batches(agent, verdict("trimmed"));

    expect(warn.mock.calls).toEqual([
      [TRIMMED_NOTICE],
      [REDUCED_NOTICE],
      [TRIMMED_NOTICE],
    ]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(true);
  });

  it("speaks again when a paced day spends the month", () => {
    /*
     * Pacing holds back spans, not requests, jobs or errors, and those still
     * count toward the allowance: an account near the end of it can spend it
     * before midnight. Free throughout and the same trees withheld, but the
     * spans no longer come back at 00:00 UTC.
     */
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("paced"));
    batches(agent, verdict("true"));

    expect(warn.mock.calls).toEqual([[PACED_NOTICE], [REDUCED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isDegraded()).toBe(true);
  });

  it.each([
    ["errors-only:spike", SPIKE_NOTICE],
    ["errors-only:budget", BUDGET_NOTICE],
    // The collector gave no reason, or one this agent has no words for.
    ["errors-only", PAUSED_NOTICE],
  ] as const)(
    "tells a paused account why only server errors are sent, once (`%s`)",
    (value, notice) => {
      const { agent, buffer, warn, log } = boot();

      batches(agent, verdict(value));

      // Not the reduced line, which is what 0.3.12 says for the same pause:
      // requests, jobs and logs are no longer recorded either.
      expect(warn.mock.calls).toEqual([[notice]]);
      expect(log).not.toHaveBeenCalled();
      expect(buffer.isErrorsOnly()).toBe(true);
    },
  );

  it("speaks again when the pause's reason changes, not otherwise", () => {
    /*
     * Spike protection paused the account, and the budget it set afterwards
     * is spent too: still paused, but resuming alone no longer lifts it.
     */
    const { agent, buffer, warn, log } = boot();

    batches(agent, verdict("errors-only:spike"));
    batches(agent, verdict("errors-only:budget"));

    expect(warn.mock.calls).toEqual([[SPIKE_NOTICE], [BUDGET_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isErrorsOnly()).toBe(true);
  });

  it("says everything is recorded again when the pause gives way to full ingest", () => {
    const { agent, buffer, warn, log } = boot();
    agent.handleMessage(verdict("errors-only:spike"));

    batches(agent, verdict("false"));

    // Not "spans are being recorded again": requests, jobs and logs are back
    // too.
    expect(warn.mock.calls).toEqual([[SPIKE_NOTICE]]);
    expect(log.mock.calls).toEqual([[UNPAUSED_NOTICE]]);
    expect(buffer.isErrorsOnly()).toBe(false);
    expect(buffer.isDegraded()).toBe(false);
  });

  it("says what is kept when the pause gives way to trimmed traces", () => {
    /*
     * A resumed Pro account is back to being trimmed past its threshold:
     * requests, jobs and errors are recorded again, most trees still are not.
     */
    const { agent, buffer, warn, log } = boot();
    agent.handleMessage(verdict("errors-only:spike"));

    batches(agent, verdict("trimmed"));

    expect(warn.mock.calls).toEqual([[SPIKE_NOTICE], [TRIMMED_NOTICE]]);
    expect(log).not.toHaveBeenCalled();
    expect(buffer.isErrorsOnly()).toBe(false);
    expect(buffer.isDegraded()).toBe(true);
  });
});
