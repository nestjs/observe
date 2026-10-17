/**
 * Explains a 429 from the collector in the operator's terms.
 *
 * The collector refuses ingest for several different reasons, and until this
 * existed the agent reported all of them as "the account may be out of
 * credits or over budget" - which sent an operator whose card had been
 * declined to the pricing page, and one whose rate cap had engaged to their
 * invoices. The body tells them apart: a quota refusal carries
 * `code: "USAGE_LIMIT_REACHED"` with the plan and the counts, and a quota
 * refusal caused by a declined payment adds `reason: "payment_failed"` - or
 * `reason: "overage_budget"` when the account's own $0 overage budget stopped
 * collection once its included events were spent. Credentials the collector
 * has already rejected carry `code: "CREDENTIALS_REJECTED"` - a 429 rather
 * than another 401, so that agents which pause only on a 429 stop retrying
 * them. A rate cap, and any older collector, sends none of these and gets the
 * old sentence.
 *
 * Written self-contained on purpose - no imports, no module-scope constants -
 * because the telemetry worker is a stringified function and this travels
 * into it as source (see `ObserveAgentWorker.initializeWorker`). Anything it
 * referenced from this module's scope would be undefined there.
 *
 * @param body the parsed JSON body of the 429, or anything else - a text
 *   body, `undefined` from a failed parse - which reads as "no detail".
 */
export const describeIngestRefusal = (body: unknown): string => {
  const detail =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};

  if (detail.code === "CREDENTIALS_REJECTED") {
    // Nothing to do with the account's usage: the credentials are wrong and
    // the process reads them once, so the fix is valid ones and a restart.
    // The pause that follows only stops the agent asking in the meantime.
    return "appKey and appSecret were rejected; check that both are valid for this application, then restart the process, which reads them once at start-up";
  }

  if (detail.code !== "USAGE_LIMIT_REACHED") {
    return "the account may be out of credits or over budget";
  }

  const plan = typeof detail.plan === "string" ? detail.plan : undefined;
  const counts =
    typeof detail.used === "number" && typeof detail.included === "number"
      ? `${detail.used.toLocaleString("en-US")} of ${detail.included.toLocaleString("en-US")} included events used` +
        (plan ? ` on the ${plan} plan` : "")
      : undefined;

  if (detail.reason === "payment_failed") {
    // The plan has overage; it is switched off because the last payment was
    // declined. The fix is a card, not an upgrade, so say so - and say that
    // it lifts on payment, since the operator will otherwise wait for the
    // period to reset.
    return (
      "a payment on the account was declined, so events past the included volume are refused until the outstanding invoice is paid" +
      (counts ? ` (${counts})` : "") +
      "; update the payment method in the dashboard to resume"
    );
  }

  if (detail.reason === "overage_budget") {
    // The account asked for nothing past its plan - a $0 overage budget - and
    // the plan's events are spent. Nothing is wrong with the plan or the
    // card, so neither an upgrade nor a payment is the fix: raising the
    // budget is, or the turn of the month, which the operator would otherwise
    // not know is coming.
    return (
      "the account's overage budget is $0 and its included events for this period are used" +
      (counts ? ` (${counts})` : "") +
      ", so collection is stopped until the 1st (UTC) or until the overage budget is raised on the dashboard's Usage page"
    );
  }

  return (
    "the account has used its included events for this period" +
    (counts ? ` (${counts})` : "") +
    "; upgrade the plan or wait for the period to reset"
  );
};
