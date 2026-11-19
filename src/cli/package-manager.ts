import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lockfiles, in the order they are looked for in each directory. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const MANAGERS = new Set<string>(["npm", "pnpm", "yarn", "bun"]);

/**
 * The package manager the project is installed with.
 *
 * The nearest lockfile decides, looked for from `cwd` up to the repository's
 * root - a package inside a workspace has its lockfile at the root. Without
 * one, Corepack's `packageManager` field in package.json does, and npm is
 * the answer when neither says anything. Running `npx` says nothing either
 * way: it is how the command was started, not how the project installs.
 *
 * A project in no repository has no root to stop at, and a lockfile above
 * it - a forgotten one in the home directory, say - belongs to something
 * else: it made link install with a manager the project does not use, and
 * outranked the project's own `packageManager` field. There, only `cwd` and
 * the workspace it is a package of, if any, are looked in.
 */
export function detectPackageManager(cwd: string): PackageManager {
  const root = repositoryRoot(cwd);
  if (root === undefined) {
    const workspace = workspaceRoot(cwd);
    return (
      lockfileIn(cwd) ??
      (workspace === undefined ? undefined : lockfileIn(workspace)) ??
      declaredPackageManager(cwd) ??
      (workspace === undefined
        ? undefined
        : declaredPackageManager(workspace)) ??
      "npm"
    );
  }
  for (let dir = cwd; ; dir = dirname(dir)) {
    const found = lockfileIn(dir);
    if (found) {
      return found;
    }
    // The repository's root is as far as the project goes: a lockfile
    // above it belongs to something else.
    if (dir === root) {
      break;
    }
  }
  return declaredPackageManager(cwd) ?? "npm";
}

function lockfileIn(dir: string): PackageManager | undefined {
  return LOCKFILES.find(([file]) => existsSync(join(dir, file)))?.[1];
}

/** The nearest directory from `cwd` up that holds a `.git`. */
function repositoryRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/**
 * The nearest directory above `cwd` that is a workspace's root - one with a
 * `pnpm-workspace.yaml`, or a package.json that lists `workspaces` - where
 * the lockfile of a package inside it is.
 */
function workspaceRoot(cwd: string): string | undefined {
  for (let dir = dirname(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) || listsWorkspaces(dir)) {
      return dir;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/** Whether `<dir>/package.json` lists `workspaces`, as npm, Yarn and Bun read them. */
function listsWorkspaces(dir: string): boolean {
  try {
    const { workspaces } = JSON.parse(
      readFileSync(join(dir, "package.json"), "utf8"),
    ) as { workspaces?: unknown };
    return (
      Array.isArray(workspaces) ||
      Array.isArray((workspaces as { packages?: unknown } | null)?.packages)
    );
  } catch {
    return false;
  }
}

/** `"pnpm@9.12.0"` in package.json's `packageManager` field, as `"pnpm"`. */
function declaredPackageManager(cwd: string): PackageManager | undefined {
  try {
    const { packageManager } = JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as { packageManager?: unknown };
    const name =
      typeof packageManager === "string"
        ? packageManager.split("@")[0]
        : undefined;
    return name && MANAGERS.has(name) ? (name as PackageManager) : undefined;
  } catch {
    return undefined;
  }
}

/** The command that adds `spec` to the project's dependencies. */
export function addDependencyCommand(
  manager: PackageManager,
  spec: string,
): [command: string, args: string[]] {
  return manager === "npm"
    ? ["npm", ["install", spec]]
    : [manager, ["add", spec]];
}
