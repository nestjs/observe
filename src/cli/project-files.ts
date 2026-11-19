import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

/** The files `link` writes in every project, whatever else it does. */
export const LINK_FILES = [".env", ".gitignore", "package.json"];

/**
 * Whether `path`, relative to `cwd`, is a file of the project's own once
 * links are followed - where `link` may write.
 *
 * A checkout's files can be links to anywhere the person can write, and a
 * project's own paths can climb out with `../`: written through, the key
 * pair, the notes or the wiring would land in someone else's file, reported
 * under an in-project name. A file still to be created is the project's when
 * its directory is; a link that leads nowhere is not, because writing to it
 * would create the file it points at.
 */
export function isProjectFile(cwd: string, path: string): boolean {
  let root: string;
  try {
    root = realpathSync.native(cwd);
  } catch {
    return false;
  }
  const file = join(cwd, path);
  let real: string;
  try {
    real = realpathSync.native(file);
  } catch {
    if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) {
      return false;
    }
    const parent = dirname(path);
    return parent === path ? false : isProjectFile(cwd, parent);
  }
  const fromRoot = relative(root, real);
  return (
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

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
 * `.env` as a path relative to `cwd` when git already tracks the file it is -
 * itself, or what it links to - or undefined: not tracked, not in a
 * repository, or no git to ask.
 *
 * An ignore rule does not apply to a file in the index, so the secret written
 * into a tracked `.env` would be in the next `git commit -a` whatever
 * `.gitignore` says. Git is asked as `askGit` asks it, with nothing of the
 * project's that could run a program.
 */
export function trackedEnvFile(cwd: string): string | undefined {
  const env = envFileOf(cwd);
  if (!env) {
    return undefined;
  }
  const status = askGit(dirname(env.path), [
    "--literal-pathspecs",
    "ls-files",
    "--error-unmatch",
    "--",
    basename(env.path),
  ]);
  return status === 0 ? relative(env.root, env.path) || ".env" : undefined;
}

/**
 * Whether git ignores the file the key pair is written into - `.env`, or
 * what it links to: true or false as git answers, undefined when there is
 * no repository or no git to ask.
 *
 * Asked of git itself, after `ensureEnvIgnored`, rather than read off
 * `.gitignore`: git decides with every ignore file there is, and a rule
 * `ensureEnvIgnored` saw does not ignore a file `.env` links to under
 * another name. Asked the way `trackedEnvFile` asks.
 */
export function envFileIgnored(cwd: string): boolean | undefined {
  const env = envFileOf(cwd);
  if (!env) {
    return undefined;
  }
  // `check-ignore` takes no `--literal-pathspecs`; a name after `./` is a
  // name, whatever it starts with.
  const status = askGit(dirname(env.path), [
    "check-ignore",
    "-q",
    "--",
    `./${basename(env.path)}`,
  ]);
  return status === 0 ? true : status === 1 ? false : undefined;
}

/**
 * The project's real directory, and the real path of its `.env` - what it
 * links to, or where it would be created.
 */
function envFileOf(cwd: string): { root: string; path: string } | undefined {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return undefined;
  }
  let path = join(root, ".env");
  try {
    path = realpathSync(path);
  } catch {
    // Not there yet, though it may still be in the index.
  }
  return { root, path };
}

/**
 * Runs git with `args` in `dir` and returns its exit status, null when it
 * could not run. Its arguments are fixed, it starts from Node's own
 * directory and is pointed at the project with `-C`, and the two settings
 * a project's own `.git/config` could use to run a program are turned off:
 * `core.fsmonitor`, which reading the index starts, and the discovery of
 * a bare repository that only sits in the checkout.
 */
function askGit(dir: string, args: string[]): number | null {
  return spawnSync(
    "git",
    [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "safe.bareRepository=explicit",
      "-C",
      dir,
      ...args,
    ],
    { cwd: dirname(process.execPath), stdio: "ignore", timeout: 10_000 },
  ).status;
}

/**
 * Why `ensureEnvIgnored` could not add `.env` to `<cwd>/.gitignore`, or
 * undefined when it can: the file is there, a regular file that can be read
 * and written, or it is not and the directory can take it. Asked before a
 * code is, so no pair is issued for a project it could not be kept out of
 * git in.
 *
 * A link is refused even when it stays in the project: git reads no
 * `.gitignore` that is a symbolic link (2.32 and later), so a rule written
 * through it would keep nothing out of git, however it read.
 */
export function gitignoreProblem(cwd: string): string | undefined {
  const path = join(cwd, ".gitignore");
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats === undefined) {
    try {
      accessSync(cwd, constants.W_OK);
      return undefined;
    } catch {
      return `There is no .gitignore in ${cwd} and the directory cannot be written to, so link could not keep .env out of git.`;
    }
  }
  if (stats.isSymbolicLink()) {
    return ".gitignore is a symbolic link, and git does not read one, so a rule in it would not keep .env out of git. Put the file itself in its place and link again.";
  }
  if (!stats.isFile()) {
    return ".gitignore is not a file, so link could not keep .env out of git.";
  }
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return undefined;
  } catch {
    return ".gitignore cannot be read and written, so link could not keep .env out of git.";
  }
}

/**
 * Makes sure `.env` is git-ignored, so the secret cannot be committed by
 * accident. `nest new` already ignores it; a project from elsewhere may not.
 * Returns whether the file had to be changed.
 */
export function ensureEnvIgnored(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Read the way git reads it. The last rule that matches decides, so a
  // `!.env` further down takes `.env` back out. Only trailing spaces are
  // dropped from a rule: an indented ` .env` names a file that starts with
  // a space, and `.env` followed by a tab one that ends with a tab.
  let ignored = false;
  for (const line of existing.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const rule = line.replace(/ +$/, "");
    if (rule === ".env" || rule === "/.env" || rule === ".env*") {
      ignored = true;
    } else if (rule.startsWith("!") && mayMatchEnv(rule.slice(1))) {
      ignored = false;
    }
  }
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

/**
 * Whether a `.gitignore` pattern can match `<cwd>/.env`. Asked only of rules
 * that take files back out, where a wrong yes costs one more `.env` line at
 * the end of the file and a wrong no costs the secret - so whatever is not
 * read exactly counts as a match: a `[class]`, a `\` escape, and a name in
 * another case, for a checkout on a case-insensitive file system.
 */
function mayMatchEnv(pattern: string): boolean {
  if (/[[\\]/.test(pattern)) {
    return true;
  }
  // `/` in front anchors it to this directory, where `.env` is anyway; one
  // at the end means directories only, and `.env` is a file.
  const name = pattern.replace(/^\//, "").replace(/^(\*\*\/)+/, "");
  if (!name || name.includes("/")) {
    return false;
  }
  const glob = name
    .replace(/[.+^${}()|]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${glob}$`, "i").test(".env");
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
