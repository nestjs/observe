/**
 * `@jridgewell/trace-mapping` is imported statically rather than pulled in on
 * first use through `createRequire(import.meta.url)`. The shim was valid only
 * under ESM: consumers whose test runner transpiles this package down to
 * CommonJS got `const require = ...` on top of the module-scope `require`,
 * which is a redeclaration - the package failed to load at all under Jest.
 * It is a hard dependency with no import-time side effects, so binding it
 * eagerly costs one module parse and keeps this file loadable either way.
 */
import {
  originalPositionFor,
  sourceContentFor,
  TraceMap,
} from "@jridgewell/trace-mapping";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A stack frame position mapped back to the source it was compiled from.
 */
export interface OriginalPosition {
  /** Absolute path of the original file, or the map-relative path if it cannot be resolved. */
  file: string;
  /** 1-based line in the original file. */
  line: number;
  /** Original source text, when the map carries `sourcesContent`. */
  content?: string[];
}

const SOURCE_MAPPING_URL_PATTERN = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/gm;

const INLINE_MAP_PREFIX = "data:application/json";

interface LoadedMap {
  /** @jridgewell/trace-mapping TraceMap instance. */
  tracer: TraceMap;
  /** Directory the map lives in, for resolving relative `sources` entries. */
  mapDir: string;
}

/**
 * Cap on distinct compiled files held. A parsed map is the largest thing this
 * package keeps, and the key is a path off a stack trace - so the cache is
 * bounded like the source cache beside it rather than trusted to stay small.
 */
const MAX_CACHED_MAPS = 200;

/** Parsed maps by compiled-file path; null marks "looked, found none". */
const mapCache = new Map<string, LoadedMap | null>();

function readMapFor(file: string): LoadedMap | null {
  let compiled: string;
  try {
    compiled = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  // Last occurrence wins: a bundle can contain the string in its own payload.
  let url: string | undefined;
  for (const match of compiled.matchAll(SOURCE_MAPPING_URL_PATTERN)) {
    url = match[1];
  }
  if (!url) {
    return null;
  }

  let rawMap: string;
  let mapDir = dirname(file);
  try {
    if (url.startsWith(INLINE_MAP_PREFIX)) {
      const base64Marker = "base64,";
      const index = url.indexOf(base64Marker);
      rawMap =
        index === -1
          ? decodeURIComponent(url.slice(url.indexOf(",") + 1))
          : Buffer.from(
              url.slice(index + base64Marker.length),
              "base64",
            ).toString("utf8");
    } else {
      const mapPath = resolve(dirname(file), url);
      mapDir = dirname(mapPath);
      rawMap = readFileSync(mapPath, "utf8");
    }
  } catch {
    return null;
  }

  try {
    return {
      tracer: new TraceMap(JSON.parse(rawMap)),
      mapDir,
    };
  } catch {
    return null;
  }
}

function getMap(file: string): LoadedMap | null {
  if (mapCache.has(file)) {
    return mapCache.get(file)!;
  }
  const loaded = readMapFor(file);
  if (mapCache.size >= MAX_CACHED_MAPS) {
    const oldest = mapCache.keys().next().value;
    if (oldest !== undefined) {
      mapCache.delete(oldest);
    }
  }
  mapCache.set(file, loaded);
  return loaded;
}

/**
 * Maps a compiled frame position back to the original source.
 *
 * Returns undefined when there is no usable map, leaving the caller to fall back
 * to the compiled file - a degraded but still truthful result.
 */
export function resolveOriginalPosition(
  file: string,
  line: number,
  column: number,
): OriginalPosition | undefined {
  const map = getMap(file);
  if (!map) {
    return undefined;
  }

  const position = originalPositionFor(map.tracer, {
    line,
    // Stack columns are 1-based, source map columns are 0-based.
    column: Math.max(0, column - 1),
  });

  if (!position.source || position.line === null) {
    return undefined;
  }

  // `sourcesContent` is the reliable path: the original text is embedded in the
  // map, so it works even when the source tree is absent at runtime (a container
  // shipping only dist, for instance).
  const embedded = sourceContentFor(map.tracer, position.source);

  return {
    file: position.source.startsWith("/")
      ? position.source
      : resolve(map.mapDir, position.source),
    line: position.line,
    content: embedded ? embedded.split("\n") : undefined,
  };
}

/** Testing seam - the caches are process-lifetime otherwise. */
export function resetSourceMapCache(): void {
  mapCache.clear();
}
