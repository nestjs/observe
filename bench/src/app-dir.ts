import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * What the application under test may resolve besides the SDK: Nest, its
 * peers and the SDK's one dependency. Nothing else.
 */
const APP_DEPENDENCIES = [
  "@nestjs/common",
  "@nestjs/core",
  "@nestjs/platform-express",
  "@nestjs/platform-fastify",
  "reflect-metadata",
  "rxjs",
  "@jridgewell/trace-mapping",
];

/** The compiled files the application under test is made of. */
const APP_FILES = ["server.js", "app.module.js", "protocol.js"];

/**
 * Lays out the application under test the way an installed app looks: its
 * own files next to a `node_modules` holding Nest and a copy of the package.
 *
 * It has to live outside this repository. The agent instruments every
 * optional peer it can resolve - `pg`, `mysql2`, `mssql`, `mongodb`, Bull,
 * BullMQ, microservices - by loading it at startup, and this repository has
 * every one of them installed for its own test suites. Resolved from here,
 * the benchmark would charge the agent for loading half a dozen drivers an
 * application would only have installed - and loaded itself - if it used
 * them. Copied rather than linked, the package resolves its peers from the
 * app's `node_modules` alone; Nest is linked, which keeps one copy of it in
 * the process.
 */
export function prepareAppDir(
  appDir: string,
  repoRoot: string,
  buildDir: string,
  /** Where the package's `package.json` and `dist` are copied from. */
  sdkDir: string = repoRoot,
): string {
  const root = resolve(appDir);
  if (!relative(repoRoot, root).startsWith("..")) {
    throw new Error(
      `The app directory must be outside the repository (${repoRoot}), or the agent resolves the repository's dev dependencies.`,
    );
  }
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "observe-bench-app",
      private: true,
      type: "module",
    }),
  );
  for (const file of APP_FILES) {
    copyFileSync(join(buildDir, file), join(root, file));
  }

  const sdk = join(root, "node_modules/@nestjs/observe");
  mkdirSync(sdk, { recursive: true });
  copyFileSync(join(sdkDir, "package.json"), join(sdk, "package.json"));
  cpSync(join(sdkDir, "dist"), join(sdk, "dist"), { recursive: true });

  for (const dependency of APP_DEPENDENCIES) {
    const target = join(repoRoot, "node_modules", dependency);
    if (!existsSync(target)) {
      throw new Error(`${dependency} is not installed in ${repoRoot}.`);
    }
    const link = join(root, "node_modules", dependency);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "dir");
  }
  return join(root, "server.js");
}
