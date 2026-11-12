import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The variables `ObserveModule` falls back to for its key pair. */
export const KEY_VARIABLE = "OBSERVE_APP_KEY";
export const SECRET_VARIABLE = "OBSERVE_APP_SECRET";

/**
 * Scripts every project is expected to start the app with. When one of them
 * does not run `nest start`, it is reported, so the caller can say how to
 * load `.env` instead.
 */
const CONVENTIONAL_START_SCRIPTS = new Set(["start", "start:dev"]);

/**
 * Printable ASCII without whitespace, a single quote or a backslash: what
 * stands between single quotes in `.env` and reads the same to every loader.
 * Key and secret are drawn from letters, digits and `!$%^&`, well inside it.
 */
const ENV_FILE_VALUE = /^[\x21-\x26\x28-\x5b\x5d-\x7e]+$/;

/**
 * Whether `value` can be written into `.env` as `writeEnvFile` writes it.
 *
 * The pair comes from the link service's reply, and `.env` is loaded into
 * the app on every start: a quote and a line break would end the value and
 * add a line of the reply's choosing - `NODE_OPTIONS=--import ...`, or a
 * `DATABASE_URL` that wins over the project's own. Refused rather than
 * escaped: no escape for a quote or a line break reads the same in Node's
 * `--env-file`, `dotenv` and a shell, and `dotenv` reads `\'` as an escaped
 * quote where Node ends the value.
 */
export function isEnvFileValue(value: unknown): value is string {
  return typeof value === "string" && ENV_FILE_VALUE.test(value);
}

/**
 * Writes the key pair into `<cwd>/.env`, replacing an earlier pair and keeping
 * every other line as it was. Created owner-only when it does not exist.
 *
 * Both values are single-quoted. Key and secret are drawn from the same
 * alphabet, which includes `$` and `&`: unquoted, a loader that expands
 * variables (`dotenv-expand`, `ConfigModule` with `expandVariables`) rewrites
 * everything after a `$`, and a shell sourcing the file stops at the `&`.
 * Node's own `--env-file` reads either form literally. Single quotes are
 * literal in all of them, and a value with a quote - or anything else
 * `isEnvFileValue` refuses - is not written at all.
 */
export function writeEnvFile(cwd: string, appKey: string, appSecret: string) {
  if (!isEnvFileValue(appKey) || !isEnvFileValue(appSecret)) {
    throw new TypeError(
      "The key pair can hold only printable ASCII without whitespace, quotes or backslashes.",
    );
  }
  const path = join(cwd, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const kept = existing
    .split(/\r?\n/)
    .filter(
      (line) =>
        !new RegExp(
          `^\\s*(export\\s+)?(${KEY_VARIABLE}|${SECRET_VARIABLE})\\s*=`,
        ).test(line),
    );
  while (kept.length && kept[kept.length - 1].trim() === "") {
    kept.pop();
  }
  const lines = [
    ...kept,
    ...(kept.length ? [""] : []),
    `${KEY_VARIABLE}='${appKey}'`,
    `${SECRET_VARIABLE}='${appSecret}'`,
    "",
  ];
  writeFileSync(path, lines.join("\n"), existing ? undefined : { mode: 0o600 });
  return path;
}

/**
 * Makes sure `.env` is git-ignored, so the secret cannot be committed by
 * accident. `nest new` already ignores it; a project from elsewhere may not.
 * Returns whether the file had to be changed.
 */
export function ensureEnvIgnored(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const ignored = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === ".env" || line === "/.env" || line === ".env*");
  if (ignored) {
    return false;
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${existing}${separator}\n# NestJS Observe key pair\n.env\n`,
  );
  return true;
}

export interface ScriptsUpdate {
  /** Scripts that now load `.env`. */
  updated: string[];
  /** `start` or `start:dev` scripts that do not run `nest start`, left alone. */
  skipped: string[];
}

/**
 * Adds `--env-file .env` to every script that runs `nest start` - `start`,
 * `start:dev` and `start:debug` in a `nest new` project, and any of a
 * monorepo's - so the pair in `.env` reaches the process however the app is
 * started locally. `start:prod` runs `node dist/main` and is left alone: in
 * production the pair comes from the environment. Scripts that already pass
 * an env file are left as they are, and a `start` or `start:dev` that starts
 * the app some other way is reported, so the caller can say how to load it.
 */
export function addEnvFileToStartScripts(cwd: string): ScriptsUpdate {
  const path = join(cwd, "package.json");
  const raw = readFileSync(path, "utf8");
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
  const result: ScriptsUpdate = { updated: [], skipped: [] };

  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    if (typeof script !== "string" || /--env-file\b/.test(script)) {
      continue;
    }
    if (/^\s*nest start\b/.test(script)) {
      pkg.scripts![name] = `${script.trimEnd()} --env-file .env`;
      result.updated.push(name);
    } else if (CONVENTIONAL_START_SCRIPTS.has(name)) {
      result.skipped.push(name);
    }
  }

  if (result.updated.length) {
    const indent = raw.match(/^[ \t]+(?=")/m)?.[0] ?? "  ";
    writeFileSync(
      path,
      JSON.stringify(pkg, null, indent) + (raw.endsWith("\n") ? "\n" : ""),
    );
  }
  return result;
}

/** The project's package name, which the link proposes as the app's name. */
export function readPackageName(cwd: string): string | undefined {
  const path = join(cwd, "package.json");
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const name = (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown })
      .name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
