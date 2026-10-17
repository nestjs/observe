import { describe, expect, it } from "vitest";
import { describeIngestRefusal } from "./ingest-refusal.util.js";

describe("describeIngestRefusal", () => {
  it("attributes a declined payment to the card, not the plan", () => {
    const message = describeIngestRefusal({
      code: "USAGE_LIMIT_REACHED",
      limit: "observability_events",
      plan: "pro",
      included: 25_000_000,
      used: 30_000_000,
      reason: "payment_failed",
    });

    // An operator reading this must not go to the pricing page: the plan is
    // fine, the payment is not, and paying lifts it at once.
    expect(message).toContain("payment on the account was declined");
    expect(message).toContain("update the payment method");
    expect(message).toContain(
      "30,000,000 of 25,000,000 included events used on the pro plan",
    );
    expect(message).not.toContain("upgrade");
  });

  it("describes an ordinary plan limit as one", () => {
    const message = describeIngestRefusal({
      code: "USAGE_LIMIT_REACHED",
      limit: "observability_events",
      plan: "free",
      included: 300_000,
      used: 300_000,
    });

    expect(message).toContain("used its included events");
    expect(message).toContain("upgrade the plan or wait");
    expect(message).not.toContain("declined");
  });

  it("sends rejected credentials to the credentials, not the account", () => {
    // What the collector answers a credential it has already refused once,
    // with Retry-After: 3600, so that agents which only pause on a 429 stop
    // retrying it every flush.
    const message = describeIngestRefusal({
      statusCode: 429,
      code: "CREDENTIALS_REJECTED",
      message: "Invalid API key or secret",
    });

    // The fix is valid credentials and a restart. The account's usage has
    // nothing to do with it, and an operator sent to the billing page would
    // find nothing wrong there.
    expect(message).toBe(
      "appKey and appSecret were rejected; check that both are valid for this application, then restart the process, which reads them once at start-up",
    );
    expect(message).not.toContain("credits");
    expect(message).not.toContain("upgrade");
  });

  it("copes with a quota body missing the counts", () => {
    expect(describeIngestRefusal({ code: "USAGE_LIMIT_REACHED" })).toBe(
      "the account has used its included events for this period; upgrade the plan or wait for the period to reset",
    );
  });

  it("sends a $0 overage budget's stop to the budget, not the plan", () => {
    // What the collector answers every batch, with Retry-After: 300, once an
    // account that set its overage budget to $0 has used its included events.
    const message = describeIngestRefusal({
      code: "USAGE_LIMIT_REACHED",
      limit: "observability_events",
      reason: "overage_budget",
      budget: 0,
      plan: "pro",
      included: 25_000_000,
      used: 25_000_000,
    });

    // The plan already bills overage and the card is fine: the account asked
    // for nothing past its plan, and the fix is the budget or the 1st.
    expect(message).toBe(
      "the account's overage budget is $0 and its included events for this period are used " +
        "(25,000,000 of 25,000,000 included events used on the pro plan), so collection is stopped " +
        "until the 1st (UTC) or until the overage budget is raised on the dashboard's Usage page",
    );
    expect(message).not.toContain("upgrade");
    expect(message).not.toContain("declined");
  });

  it("copes with a $0 overage budget's body missing the counts", () => {
    expect(
      describeIngestRefusal({
        code: "USAGE_LIMIT_REACHED",
        reason: "overage_budget",
      }),
    ).toBe(
      "the account's overage budget is $0 and its included events for this period are used, so collection is stopped " +
        "until the 1st (UTC) or until the overage budget is raised on the dashboard's Usage page",
    );
  });

  it.each([
    ["a rate-cap body", { statusCode: 429, message: "Too Many Requests" }],
    ["a text body", "Too Many Requests"],
    ["no body", undefined],
    ["null", null],
  ])("falls back to the generic sentence for %s", (_, body) => {
    expect(describeIngestRefusal(body)).toBe(
      "the account may be out of credits or over budget",
    );
  });

  it("survives being stringified into the worker", () => {
    // The telemetry worker receives this as source, not as a module import,
    // so it must not close over anything - a constant hoisted out of it
    // would be undefined there and every 429 would throw inside the worker.
    // oxlint-disable-next-line no-implied-eval -- rehydrating from source is the point of the test
    const rehydrated = new Function(
      `return (${describeIngestRefusal.toString()})`,
    )() as typeof describeIngestRefusal;

    expect(
      rehydrated({ code: "USAGE_LIMIT_REACHED", reason: "payment_failed" }),
    ).toContain("declined");
    expect(
      rehydrated({ code: "USAGE_LIMIT_REACHED", reason: "overage_budget" }),
    ).toContain("overage budget is $0");
    expect(rehydrated({ code: "CREDENTIALS_REJECTED" })).toContain(
      "appKey and appSecret were rejected",
    );
    expect(rehydrated(undefined)).toBe(
      "the account may be out of credits or over budget",
    );
  });
});
