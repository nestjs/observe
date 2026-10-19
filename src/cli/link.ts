import {
  addEnvFileToStartScripts,
  ensureEnvIgnored,
  readPackageName,
  replaceScaffoldPlaceholders,
  writeEnvFile,
} from "./project-files.js";

export interface LinkOptions {
  /** The project directory: where `package.json` and `.env` live. */
  cwd: string;
  /** The API base URL - the collector's, which also serves the link. */
  endpoint: string;
  /** Whether to try opening the link page in a browser. */
  openBrowser: boolean;
}

export interface LinkDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  openUrl: (url: string) => void;
  log: (line: string) => void;
  hostname: () => string;
  now: () => number;
}

interface StartedLink {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface LinkedCredentials {
  appKey: string;
  appSecret: string;
  projectName: string;
  applicationName: string;
}

/** Extra seconds `slow_down` adds to the interval, as RFC 8628 says. */
const SLOW_DOWN_SECONDS = 5;

/**
 * `npx @nestjs/observe link`: asks the API for a code, has the person type it
 * into the dashboard and approve, then writes the key pair it receives into
 * `.env`, makes the start scripts load it, and points a `nest new` AppModule's
 * placeholders at it.
 *
 * Returns the process exit code. Nothing is written until the key pair has
 * arrived, so an interrupted, denied or expired link leaves the project as it
 * was.
 */
export async function link(
  options: LinkOptions,
  deps: LinkDependencies,
): Promise<number> {
  const applicationName = readPackageName(options.cwd);
  if (applicationName === undefined) {
    deps.log(
      `No package.json in ${options.cwd}. Run this in your NestJS project's directory.`,
    );
    return 1;
  }

  let started: StartedLink;
  try {
    started = await post<StartedLink>(deps, options.endpoint, "sessions", {
      applicationName,
      hostname: deps.hostname(),
    });
  } catch (err) {
    deps.log(
      `Could not reach NestJS Observe at ${options.endpoint}: ${describe(err)}`,
    );
    return 1;
  }

  deps.log("");
  deps.log(`  Open      ${started.verificationUri}`);
  deps.log(`  and type  ${started.userCode}`);
  deps.log("");
  deps.log(
    `Waiting for you to approve it in the dashboard. The code expires in ${Math.round(started.expiresIn / 60)} minutes.`,
  );
  if (options.openBrowser) {
    // The page only, never the code: the code is typed, so a link that
    // carries it cannot approve anything on its own.
    deps.openUrl(started.verificationUri);
  }

  const credentials = await waitForApproval(deps, options.endpoint, started);
  if (typeof credentials === "string") {
    deps.log(credentials);
    return 1;
  }

  writeEnvFile(options.cwd, credentials.appKey, credentials.appSecret);
  const ignoredNow = ensureEnvIgnored(options.cwd);
  const scripts = addEnvFileToStartScripts(options.cwd);
  const placeholders = replaceScaffoldPlaceholders(options.cwd);

  deps.log("");
  deps.log(
    `✔ Linked to ${credentials.applicationName} in ${credentials.projectName}. The key pair is in .env.`,
  );
  if (ignoredNow) {
    deps.log("  Added .env to .gitignore, so the secret stays out of git.");
  }
  if (scripts.updated.length) {
    deps.log(
      `  ${listScripts(scripts.updated)} now load${scripts.updated.length === 1 ? "s" : ""} it with --env-file .env.`,
    );
  }
  if (scripts.skipped.length) {
    deps.log(
      `  ${listScripts(scripts.skipped)} do${scripts.skipped.length === 1 ? "es" : ""} not run nest start, so load .env there yourself (node --env-file=.env).`,
    );
  }
  if (placeholders.updated.length) {
    deps.log(
      `  ${listFiles(placeholders.updated)} now read${placeholders.updated.length === 1 ? "s" : ""} the pair from OBSERVE_APP_KEY and OBSERVE_APP_SECRET in place of the YOUR_APP_KEY placeholders.`,
    );
  }
  if (placeholders.outdatedSdk.length) {
    deps.log(
      `  ${listFiles(placeholders.outdatedSdk)} still hold${placeholders.outdatedSdk.length === 1 ? "s" : ""} the YOUR_APP_KEY placeholders. The SDK reads .env in their place, so the app reports anyway; to have the code say so, update @nestjs/observe to 0.3.16 or later and run link again.`,
    );
  }
  deps.log(
    "  Start the app and it reports to NestJS Observe. In production, set OBSERVE_APP_KEY and OBSERVE_APP_SECRET in the environment instead.",
  );
  return 0;
}

/**
 * Polls until the link is approved, denied or expires. A string is the
 * message to end on; transient network failures are retried until the code's
 * own expiry, since the person may still be approving.
 */
async function waitForApproval(
  deps: LinkDependencies,
  endpoint: string,
  started: StartedLink,
): Promise<LinkedCredentials | string> {
  const deadline = deps.now() + started.expiresIn * 1000;
  let interval = started.interval;

  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);
    const response = await deps
      .fetch(`${endpoint}/cli-link/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceCode: started.deviceCode }),
      })
      .catch(() => null);
    if (!response) {
      continue;
    }
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
    } & Partial<LinkedCredentials>;

    if (response.ok && body.appKey && body.appSecret) {
      return body as LinkedCredentials;
    }
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += SLOW_DOWN_SECONDS;
        continue;
      case "access_denied":
        return "The link was denied in the dashboard. Nothing was written.";
      case "expired_token":
        return "The code expired before it was approved. Run npx @nestjs/observe link again.";
      default:
        // A 5xx or a gateway page: try again on the next tick.
        continue;
    }
  }
  return "The code expired before it was approved. Run npx @nestjs/observe link again.";
}

async function post<T>(
  deps: LinkDependencies,
  endpoint: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await deps.fetch(`${endpoint}/cli-link/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

/** `"start"`, `"start" and "start:dev"`, `"start", "start:dev" and "start:debug"`. */
function listScripts(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length > 1
    ? `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`
    : quoted[0];
}

/** `src/app.module.ts`, `src/a.ts and src/b.ts`. */
function listFiles(paths: string[]): string {
  return paths.length > 1
    ? `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`
    : paths[0];
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
