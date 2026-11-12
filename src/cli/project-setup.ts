import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix } from "node:path";
import type * as TS from "typescript";

export type TypeScript = typeof TS;

export const SDK_PACKAGE = "@nestjs/observe";

/** The oldest NestJS major the SDK's peer range takes. */
const MIN_NEST_MAJOR = 11;

/** Where the setup by hand is written down, for whatever link cannot do. */
export const QUICK_START_URL =
  "https://observe.nestjs.com/documentation/sdk#quick-start";

/** Directories never searched for the SDK's imports. */
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".git",
]);

/** Enough to cover any real source tree, and a bound on a pathological one. */
const MAX_SCANNED_FILES = 20_000;

/** What link has to do to the project, besides writing the key pair. */
export interface ProjectSetup {
  /**
   * `@nestjs/observe` is not a dependency yet - or the app still has to be
   * wired and the installed SDK is older than this one, whose types the
   * wiring is written against.
   */
  install: boolean;
  /** No source file uses `@nestjs/observe` yet. */
  wire: boolean;
  /** Why the project cannot take the SDK, when it cannot. */
  unsupported?: string;
}

/**
 * Looks at the project before anything is asked of the API, so a project the
 * SDK cannot run in is turned away before a key is issued for it, and the
 * person approving knows what else the command is about to change.
 */
export function inspectProject(
  cwd: string,
  version: string,
  ts: TypeScript | undefined,
): ProjectSetup {
  const pkg = readPackageJson(cwd);
  const declared = declaredRange(pkg, SDK_PACKAGE);
  const wire = !usesSdk(cwd, readNestCliConfig(cwd, ts));
  const installed = installedVersion(cwd, SDK_PACKAGE);
  const install =
    declared === undefined ||
    (wire && (installed === undefined || isOlder(installed, version)));

  if (!install) {
    return { install, wire };
  }
  const nest =
    installedVersion(cwd, "@nestjs/core") ?? declaredRange(pkg, "@nestjs/core");
  if (nest === undefined) {
    return {
      install,
      wire,
      unsupported:
        "This does not look like a NestJS project: package.json has no @nestjs/core",
    };
  }
  const major = Number(/\d+/.exec(nest)?.[0]);
  if (major < MIN_NEST_MAJOR) {
    return {
      install,
      wire,
      unsupported: `NestJS Observe needs NestJS ${MIN_NEST_MAJOR} or later, and this project has @nestjs/core ${nest}. Upgrade NestJS first`,
    };
  }
  return { install, wire };
}

/**
 * The project's own TypeScript, which the code is edited with - parsed by the
 * compiler that will build it, so whatever syntax the project uses, it reads.
 * Undefined without one; the CLI does not bring a compiler of its own.
 *
 * Found in the `node_modules` directories the project resolves from, and
 * loaded by its absolute path from the CLI's own module. Not asked of the
 * project as `require("typescript")`: Node answers that with package
 * self-reference first, and in a project named `typescript` with `exports`
 * it would load and run the project's own file instead, on every link.
 */
export function loadTypeScript(cwd: string): TypeScript | undefined {
  try {
    const installed = createRequire(join(cwd, "package.json"))
      .resolve.paths("typescript")
      ?.map((dir) => join(dir, "typescript"))
      .find((dir) => existsSync(join(dir, "package.json")));
    if (installed === undefined) {
      return undefined;
    }
    const ts = createRequire(import.meta.url)(installed) as TypeScript;
    return typeof ts.createSourceFile === "function" ? ts : undefined;
  } catch {
    return undefined;
  }
}

interface NestCliProject {
  type?: string;
  root?: string;
  sourceRoot?: string;
  entryFile?: string;
}

interface NestCliConfig {
  sourceRoot?: string;
  entryFile?: string;
  projects?: Record<string, NestCliProject | undefined>;
}

/**
 * `nest-cli.json`, the file the Nest CLI loads. It may carry comments, which
 * only the project's TypeScript can read past; without it such a file counts
 * as absent, and the defaults - `src/main.ts` - apply.
 */
function readNestCliConfig(
  cwd: string,
  ts: TypeScript | undefined,
): NestCliConfig {
  for (const name of ["nest-cli.json", ".nest-cli.json"]) {
    const path = join(cwd, name);
    if (!existsSync(path)) {
      continue;
    }
    const text = readFileSync(path, "utf8");
    try {
      return JSON.parse(text) as NestCliConfig;
    } catch {
      const parsed = ts?.parseConfigFileTextToJson(path, text);
      return (parsed?.config as NestCliConfig | undefined) ?? {};
    }
  }
  return {};
}

/**
 * The entry files of the project's applications, relative to it: the root
 * application's, and every application project's in a monorepo. A monorepo's
 * root usually names one of its own projects, so duplicates collapse.
 */
export function findEntryFiles(
  cwd: string,
  ts: TypeScript | undefined,
): string[] {
  const config = readNestCliConfig(cwd, ts);
  const found = new Set<string>();
  const add = (
    sourceRoot: string | undefined,
    entryFile: string | undefined,
  ) => {
    if (!sourceRoot) {
      return;
    }
    const path = posix.normalize(
      `${sourceRoot.replace(/\\/g, "/")}/${entryFile ?? "main"}.ts`,
    );
    if (existsSync(join(cwd, path))) {
      found.add(path);
    }
  };
  for (const project of Object.values(config.projects ?? {})) {
    if (project?.type === "library") {
      continue;
    }
    add(
      project?.sourceRoot ??
        (project?.root ? `${project.root}/src` : undefined),
      project?.entryFile,
    );
  }
  add(config.sourceRoot ?? "src", config.entryFile);
  return [...found];
}

/**
 * Whether any source file already imports the SDK: a `nest new` project
 * generated with Observe, or one wired by hand. Either way the code is left
 * alone.
 */
function usesSdk(cwd: string, config: NestCliConfig): boolean {
  const roots = new Set([config.sourceRoot ?? "src", "apps", "libs"]);
  for (const project of Object.values(config.projects ?? {})) {
    const root = project?.sourceRoot ?? project?.root;
    if (root) {
      roots.add(root);
    }
  }
  let budget = MAX_SCANNED_FILES;
  const search = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (budget <= 0) {
        return false;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && search(path)) {
          return true;
        }
      } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
        budget -= 1;
        if (readFileSync(path, "utf8").includes(SDK_PACKAGE)) {
          return true;
        }
      }
    }
    return false;
  };
  return [...roots].some((root) => search(join(cwd, root)));
}

function readPackageJson(cwd: string): Record<string, unknown> {
  try {
    return JSON.parse(
      readFileSync(join(cwd, "package.json"), "utf8"),
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** The range package.json asks for `name` in, from any dependency section. */
function declaredRange(
  pkg: Record<string, unknown>,
  name: string,
): string | undefined {
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ]) {
    const range = (pkg[section] as Record<string, unknown> | undefined)?.[name];
    if (typeof range === "string") {
      return range;
    }
  }
  return undefined;
}

/**
 * The version of `name` the project resolves, hoisted or not. Read off the
 * package's own package.json, found from its entry point when the package
 * does not export that file.
 */
function installedVersion(cwd: string, name: string): string | undefined {
  const require = createRequire(join(cwd, "package.json"));
  const readVersion = (path: string) => {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      version?: string;
    };
    return pkg.name === name ? pkg.version : undefined;
  };
  try {
    return readVersion(require.resolve(`${name}/package.json`));
  } catch {
    // Not exported, or not installed: try the entry point.
  }
  try {
    for (let dir = dirname(require.resolve(name)); ; dir = dirname(dir)) {
      const path = join(dir, "package.json");
      if (existsSync(path)) {
        const version = readVersion(path);
        if (version) {
          return version;
        }
      }
      if (dirname(dir) === dir) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  }
}

/** `"0.3.16"`, or `"0.3.16-beta.1"`, as `[0, 3, 16]`. */
function releaseOf(version: string): number[] {
  return (/(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []).slice(1, 4).map(Number);
}

/** Whether `a` is an older release than `b`, by major, minor and patch. */
function isOlder(a: string, b: string): boolean {
  const [x, y] = [releaseOf(a), releaseOf(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) < (y[i] ?? 0);
    }
  }
  return false;
}

/**
 * The application's name the way the dashboard turns it into a `serviceId`
 * for the setup it shows, so the two agree: lower-case, dashes for spaces,
 * nothing else but letters and digits. The package name stands in when the
 * application's name leaves nothing.
 */
export function serviceIdFor(...names: Array<string | undefined>): string {
  for (const name of names) {
    const id = (name ?? "")
      .replace(/^@[^/]+\//, "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/[^a-z0-9-]/g, "");
    if (id) {
      return id;
    }
  }
  return "app";
}
