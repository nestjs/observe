import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";

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
 * Writes the key pair into `<cwd>/.env`, replacing an earlier pair and keeping
 * every other line as it was. Created owner-only when it does not exist.
 *
 * Both values are single-quoted. Key and secret are drawn from the same
 * alphabet, which includes `$` and `&`: unquoted, a loader that expands
 * variables (`dotenv-expand`, `ConfigModule` with `expandVariables`) rewrites
 * everything after a `$`, and a shell sourcing the file stops at the `&`.
 * Node's own `--env-file` reads either form literally. Single quotes are
 * literal in all of them, and the alphabet has no quote in it to escape.
 */
export function writeEnvFile(cwd: string, appKey: string, appSecret: string) {
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

/** The values `nest new` scaffolds into `ObserveModule.forRoot()`. */
const SCAFFOLD_PLACEHOLDERS = [
  { option: "appKey", placeholder: "YOUR_APP_KEY", variable: KEY_VARIABLE },
  {
    option: "appSecret",
    placeholder: "YOUR_APP_SECRET",
    variable: SECRET_VARIABLE,
  },
] as const;

const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

export interface PlaceholderUpdate {
  /** Files whose placeholders now read the environment. */
  updated: string[];
  /**
   * Files that still hold placeholders, because the installed SDK types the
   * pair as required strings and `process.env` would not compile there.
   */
  outdatedSdk: string[];
}

/**
 * Swaps the `nest new` placeholders - `appKey: 'YOUR_APP_KEY'`,
 * `appSecret: 'YOUR_APP_SECRET'` - for `process.env.OBSERVE_APP_KEY` and
 * `process.env.OBSERVE_APP_SECRET`, now that `.env` holds the real pair.
 *
 * The SDK already reads the environment in place of a placeholder, so the
 * application reports either way. But a linked project whose AppModule still
 * says `YOUR_APP_KEY` reads as one that was never set up, and invites pasting
 * the secret into the code - the one place it must not go.
 *
 * Only in TypeScript sources whose installed SDK types the pair as optional:
 * against the older, required `string`, `process.env.*` is `string |
 * undefined` and a strict project would stop compiling. Those are reported
 * instead, and left as they are.
 */
export function replaceScaffoldPlaceholders(cwd: string): PlaceholderUpdate {
  const result: PlaceholderUpdate = { updated: [], outdatedSdk: [] };
  let typesAcceptEnv: boolean | undefined;

  for (const path of sourceFiles(cwd)) {
    const content = readFileSync(path, "utf8");
    if (
      !SCAFFOLD_PLACEHOLDERS.some(({ placeholder }) =>
        content.includes(placeholder),
      )
    ) {
      continue;
    }
    let updated = content;
    for (const { option, placeholder, variable } of SCAFFOLD_PLACEHOLDERS) {
      updated = updated.replace(
        new RegExp(`(\\b${option}\\s*:\\s*)(['"\`])${placeholder}\\2`, "g"),
        `$1process.env.${variable}`,
      );
    }
    if (updated === content) {
      continue;
    }
    const name = relative(cwd, path).split(sep).join("/");
    if (/\.[mc]?ts$/.test(path)) {
      typesAcceptEnv ??= sdkTypesAcceptEnv(cwd);
      if (!typesAcceptEnv) {
        result.outdatedSdk.push(name);
        continue;
      }
    }
    writeFileSync(path, updated);
    result.updated.push(name);
  }
  return result;
}

/**
 * The project's sources: `src`, or the source roots `nest-cli.json` names -
 * a monorepo's every application and library.
 */
function sourceFiles(cwd: string): string[] {
  const roots = new Set(["src"]);
  try {
    const config = JSON.parse(
      readFileSync(join(cwd, "nest-cli.json"), "utf8"),
    ) as {
      sourceRoot?: string;
      projects?: Record<string, { sourceRoot?: string; root?: string }>;
    };
    if (config.sourceRoot) {
      roots.add(config.sourceRoot);
    }
    for (const project of Object.values(config.projects ?? {})) {
      const root = project?.sourceRoot ?? project?.root;
      if (root) {
        roots.add(root);
      }
    }
  } catch {
    // No nest-cli.json, or not JSON: `src` is all there is to look in.
  }

  const files = new Set<string>();
  const walk = (directory: string) => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry)) {
        continue;
      }
      const path = join(directory, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        walk(path);
      } else if (SOURCE_FILE.test(entry) && !entry.endsWith(".d.ts")) {
        files.add(path);
      }
    }
  };
  for (const root of roots) {
    walk(join(cwd, root));
  }
  return [...files].sort();
}

/**
 * Whether the `@nestjs/observe` this project has installed types `appKey` as
 * optional - 0.3.16 and later - so `process.env.OBSERVE_APP_KEY` compiles in
 * a strict project. Read from its declarations rather than its version, which
 * says nothing about a build from a branch or a link. Not installed, or
 * unreadable, counts as no: a guess that breaks the build is worse than a
 * placeholder that still works.
 */
function sdkTypesAcceptEnv(cwd: string): boolean {
  try {
    const manifest = createRequire(join(cwd, "package.json")).resolve(
      "@nestjs/observe/package.json",
    );
    const declarations = readFileSync(
      join(
        dirname(manifest),
        "dist",
        "interfaces",
        "observe-options.interface.d.ts",
      ),
      "utf8",
    );
    return /\bappKey\?\s*:/.test(declarations);
  } catch {
    return false;
  }
}
