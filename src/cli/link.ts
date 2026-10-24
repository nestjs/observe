import { writeAgentNotes } from "./agent-notes.js";
import {
  addDependencyCommand,
  detectPackageManager,
  PackageManager,
} from "./package-manager.js";
import {
  addEnvFileToStartScripts,
  ensureEnvIgnored,
  readPackageName,
  writeEnvFile,
} from "./project-files.js";
import {
  findEntryFiles,
  inspectProject,
  ProjectSetup,
  QUICK_START_URL,
  SDK_PACKAGE,
  serviceIdFor,
  TypeScript,
} from "./project-setup.js";
import { wireApplication, WireResult } from "./wire-application.js";

export interface LinkOptions {
  /** The project directory: where `package.json` and `.env` live. */
  cwd: string;
  /** The API base URL - the collector's, which also serves the link. */
  endpoint: string;
  /** Whether to try opening the link page in a browser. */
  openBrowser: boolean;
  /** This package's version: what a project without the SDK gets. */
  version: string;
}

export interface LinkDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  openUrl: (url: string) => void;
  log: (line: string) => void;
  hostname: () => string;
  now: () => number;
  /**
   * Runs a command in the project with the terminal attached - the package
   * manager's output is the progress - and resolves to its exit code.
   */
  run: (command: string, args: string[], cwd: string) => Promise<number>;
  /** The project's own TypeScript, or undefined when it has none. */
  loadTypeScript: (cwd: string) => TypeScript | undefined;
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
 * `.env` and makes the start scripts load it.
 *
 * In a project that does not use the SDK yet, it also installs it with the
 * project's package manager and wires it into the root module and `main.ts`
 * (see `wireApplication`) - so an existing app is set up by the one command,
 * as a `nest new` one is. The person is told before they approve.
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

  const setup = inspectProject(
    options.cwd,
    options.version,
    deps.loadTypeScript(options.cwd),
  );
  if (setup.unsupported) {
    deps.log(`${setup.unsupported}. Nothing was written.`);
    return 1;
  }
  const manager = detectPackageManager(options.cwd);

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
  const plan = describePlan(setup, manager);
  if (plan) {
    deps.log(plan);
  }
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

  if (setup.install) {
    const spec = `${SDK_PACKAGE}@^${options.version}`;
    const [command, args] = addDependencyCommand(manager, spec);
    deps.log("");
    deps.log(`Installing ${spec} with ${manager}...`);
    const exitCode = await deps.run(command, args, options.cwd).catch(() => -1);
    if (exitCode !== 0) {
      deps.log(
        `✖ ${[command, ...args].join(" ")} did not finish. Run it yourself, then add the SDK to the app: ${QUICK_START_URL}`,
      );
      return 1;
    }
    deps.log(`✔ Installed ${spec}.`);
  }

  let wired = true;
  let rootModule: string | undefined;
  if (setup.wire) {
    const result = wire(
      deps,
      options.cwd,
      serviceIdFor(credentials.applicationName, applicationName),
    );
    if (result.kind === "wired") {
      deps.log("✔ Wired it into the app:");
      const width = Math.max(...result.files.map((file) => file.path.length));
      for (const file of result.files) {
        deps.log(`    ${file.path.padEnd(width)}  ${file.change}`);
      }
      deps.log("  Review the changes with git diff.");
      rootModule = result.files.find(
        (file) => !/(^|\/)main\.ts$/.test(file.path),
      )?.path;
    } else {
      wired = false;
      deps.log(`! Not wired into the app: ${result.reason}.`);
      deps.log(`  Add it by hand - three edits: ${QUICK_START_URL}`);
    }
  }

  // Where a coding agent working on the project learns that its production
  // data exists, and how to reach it. Quietly: the console is for the link
  // itself, and the file shows up in the diff like the wiring does. Optional
  // too - the link is done either way.
  try {
    writeAgentNotes(options.cwd, rootModule);
  } catch {
    // A read-only checkout or an odd file: nothing the person has to act on.
  }
  deps.log(
    `  ${wired ? "Start the app" : "Once it is wired, start the app"} and it reports to NestJS Observe. In production, set OBSERVE_APP_KEY and OBSERVE_APP_SECRET in the environment instead.`,
  );
  return 0;
}

/**
 * What else the link will change, said while the person can still decide not
 * to approve. Nothing for a project that already uses the SDK.
 */
function describePlan(
  setup: ProjectSetup,
  manager: PackageManager,
): string | undefined {
  const wiring = "wires it into the app's root module and main.ts";
  if (setup.install && setup.wire) {
    return `This project does not use NestJS Observe yet: once you approve, link also installs ${SDK_PACKAGE} with ${manager} and ${wiring}.`;
  }
  if (setup.wire) {
    return `The app does not use ${SDK_PACKAGE} yet: once you approve, link also ${wiring}.`;
  }
  if (setup.install) {
    return `Once you approve, link also installs ${SDK_PACKAGE} with ${manager}.`;
  }
  return undefined;
}

/**
 * Wires the SDK into the project's one application. Asked for TypeScript
 * again rather than reusing what the inspection had: an install has just
 * run, and may have been what brought it.
 */
function wire(
  deps: LinkDependencies,
  cwd: string,
  serviceId: string,
): WireResult {
  const ts = deps.loadTypeScript(cwd);
  if (!ts) {
    return {
      kind: "manual",
      reason:
        "the project's TypeScript, which the code is edited with, could not be loaded",
    };
  }
  const entries = findEntryFiles(cwd, ts);
  if (entries.length === 0) {
    return {
      kind: "manual",
      reason: "could not find the application's main.ts",
    };
  }
  if (entries.length > 1) {
    // One key is one application: wiring them all would report every app
    // in the workspace as this one.
    return {
      kind: "manual",
      reason: `this workspace has ${entries.length} applications (${entries.join(", ")}), and the key is for one of them`,
    };
  }
  return wireApplication(ts, cwd, entries[0], serviceId);
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

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
