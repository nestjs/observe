import type { NodeAdapter } from "@nestjs/platform-node";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * The major of the Nest the suites run on: the newest, which the
 * devDependencies pin, or an older one CI's older-Nest job swaps in
 * (scripts/use-nest.cjs). The few cases that need a newer framework than the
 * SDK's floor gate on it, so that job runs everything else.
 *
 * Gated on the version rather than on whether a package loads: a dependency
 * dropped from the dev tree by mistake should fail the newest-Nest run, not
 * quietly skip in it.
 */
export const nestMajor = Number(readCoreManifest().version.split(".")[0]);

/**
 * Read beside the entry point rather than required by name: early Nest 12
 * export maps, 12.0.1's among them, have no `./package.json` and turn
 * `@nestjs/core/package.json` into `package.json.js`. Checked for its name, so
 * a layout change fails here instead of gating every case off.
 */
function readCoreManifest(): { name: string; version: string } {
  const entry = createRequire(import.meta.url).resolve("@nestjs/core");
  const manifest = JSON.parse(
    readFileSync(join(dirname(entry), "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (manifest.name !== "@nestjs/core") {
    throw new Error(`no @nestjs/core manifest beside ${entry}`);
  }
  return manifest;
}

/**
 * The platforms a suite runs on, less `node` before Nest 12 -
 * `@nestjs/platform-node` has no earlier line, and the older-Nest job does
 * not install it there.
 */
export function onPlatforms<P extends string>(platforms: P[]): P[] {
  return nestMajor >= 12
    ? platforms
    : platforms.filter((platform) => platform !== "node");
}

/**
 * A `NodeAdapter`, loaded when a `node` case first needs one rather than
 * imported statically: on Nest 11 the package is absent, and a static import
 * would fail every case in the file, the Express and Fastify ones with it.
 */
export async function createNodeAdapter(): Promise<NodeAdapter> {
  const { NodeAdapter } = await import("@nestjs/platform-node");
  return new NodeAdapter();
}
