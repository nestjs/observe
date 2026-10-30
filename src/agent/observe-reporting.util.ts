import type { ObserveOptions } from "../interfaces/observe-options.interface.js";

/**
 * The hosted collector. Unlike a collector in placeholder mode, it accepts
 * nothing without credentials.
 */
const HOSTED_COLLECTOR_ENDPOINT = "https://observe-api.nestjs.com";

/**
 * Where signals are posted when `endpoint` is not configured.
 */
const DEFAULT_COLLECTOR_ENDPOINT =
  process.env.OBSERVE_ENDPOINT ?? HOSTED_COLLECTOR_ENDPOINT;

/**
 * The credentials `nest new --observe` writes into `AppModule`.
 *
 * A project fresh from the generator has these until someone signs up, so
 * they mean "not connected yet", not "wrong": sending them only buys a 401
 * and an `Error:` line on the very first `npm run start`.
 */
const SCAFFOLD_APP_KEY = "YOUR_APP_KEY";
const SCAFFOLD_APP_SECRET = "YOUR_APP_SECRET";

/** The options that decide whether, and where, the agent reports. */
type ReportingOptions = Pick<
  ObserveOptions,
  "enabled" | "appKey" | "appSecret" | "endpoint"
>;

/** The collector the agent posts to: `endpoint`, else the default. */
export function collectorEndpointOf(options: ReportingOptions): string {
  return options.endpoint ?? DEFAULT_COLLECTOR_ENDPOINT;
}

export function hasScaffoldCredentials(options: ReportingOptions): boolean {
  return (
    options.appKey === SCAFFOLD_APP_KEY &&
    options.appSecret === SCAFFOLD_APP_SECRET
  );
}

/**
 * Whether `endpoint` - set, from `OBSERVE_ENDPOINT`, or the default - is the
 * hosted collector. Compared by host, so a trailing slash or a capital
 * letter cannot pass it off as a collector of the user's own.
 */
export function isHostedCollector(endpoint: string): boolean {
  try {
    return (
      new URL(endpoint).hostname === new URL(HOSTED_COLLECTOR_ENDPOINT).hostname
    );
  } catch {
    // Not a URL at all; the worker says so when it tries to send.
    return false;
  }
}

/**
 * Whether credentials are missing and the collector is the hosted one,
 * which answers every batch without them with a 401.
 *
 * The worker leaves both headers off when either half is unset, which a
 * collector in placeholder mode accepts, so a collector of the user's own
 * still gets those batches. The hosted collector refuses them for as long
 * as the process runs: on 2026-10-15 that was 42% of the 1.87M batches it
 * refused, from processes deployed without their environment variables,
 * some of them posting every five seconds for weeks.
 */
export function lacksHostedCredentials(options: ReportingOptions): boolean {
  return (
    (!options.appKey || !options.appSecret) &&
    isHostedCollector(collectorEndpointOf(options))
  );
}

/**
 * Whether the agent sends NestJS Observe anything: not with `enabled:
 * false`, not with `nest new`'s placeholders, and not without both
 * credentials when `endpoint` is the hosted collector. Another `endpoint` - a
 * proxy that adds them on the way - is sent to either way.
 *
 * The worker starts only when this holds. So does OTLP export, which runs
 * beside reporting to Observe, never instead of it.
 */
export function sendsToObserve(options: ReportingOptions): boolean {
  return !(
    options.enabled === false ||
    hasScaffoldCredentials(options) ||
    lacksHostedCredentials(options)
  );
}
