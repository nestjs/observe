import { readFileSync, realpathSync } from "fs";
import { resolve, sep } from "path";
import { resolveOriginalPosition } from "./source-map-resolver.util.js";

/**
 * A slice of source around a stack frame, for rendering the throw site.
 */
export interface CodeFrame {
  /** Absolute path of the file the frame points at. */
  file: string;
  /** 1-based line the frame points at - the line to highlight. */
  line: number;
  /** 1-based line number that `lines[0]` corresponds to. */
  firstLine: number;
  /** Source lines, `firstLine` through `firstLine + lines.length - 1`. */
  lines: string[];
}

const DEFAULT_LINES_OF_CONTEXT = 5;

/**
 * Frames worth reading source for. Everything below the app - dependencies and
 * the Node internals - is noise on a stack view and would balloon the payload.
 */
const IGNORED_FRAME_PATTERNS = [
  /[\\/]node_modules[\\/]/,
  /^node:/,
  /^internal[\\/]/,
  /^\s*$/,
];

/**
 * Cap on distinct files held in memory. Source files do not change while the
 * process runs, so entries never need invalidating; this only bounds a pathological
 * process that throws from thousands of distinct files.
 */
const MAX_CACHED_FILES = 200;

const MAX_LINES_OF_CONTEXT = 50;
const MAX_FRAMES = 20;

/**
 * Files already read, including ones that failed (cached as null) so a bundled or
 * deleted file is not retried on every single throw.
 */
const sourceCache = new Map<string, string[] | null>();

/** What opens every V8 frame line. */
const FRAME_PREFIX = /^\s*at\s+/;

/**
 * Longest line read as a frame, and most frame lines read from one stack. A
 * real frame is a function name and a path; a real stack is `stackTraceLimit`
 * of them. Anything past either is not something V8 wrote.
 */
const MAX_FRAME_LINE_LENGTH = 1024;
const MAX_FRAME_LINES = 100;

interface ParsedFrame {
  file: string;
  line: number;
  column: number;
}

function isIgnored(file: string): boolean {
  return IGNORED_FRAME_PATTERNS.some((pattern) => pattern.test(file));
}

/**
 * Extensions a stack frame can legitimately point at. An allowlist rather than
 * a denylist, because the set of files that must never be read (`.env`, key
 * material, arbitrary system files) is open-ended and the set of files V8 can
 * actually be executing is not.
 */
const READABLE_EXTENSIONS = /\.(?:js|cjs|mjs|jsx|ts|cts|mts|tsx)$/;

/**
 * Whether a frame's path is one this module is willing to read and ship.
 *
 * A stack string is not a trusted input: `Error#stack` is message plus frames,
 * the message routinely interpolates user data, and a multi-line value there
 * puts attacker-chosen text on its own line where it parses exactly like a
 * frame. An unrestricted reader would turn that into "log a crafted string,
 * receive any file on the host in the telemetry store". So only files under
 * the application's own root, with an extension the runtime can execute, are
 * eligible - which is also precisely the set of files worth rendering.
 */
function isReadableSourcePath(
  file: string,
  root: string = resolve(process.cwd()),
): boolean {
  if (!READABLE_EXTENSIONS.test(file)) {
    return false;
  }
  const resolved = resolve(file);
  return resolved === root || resolved.startsWith(root + sep);
}

/**
 * The lines of a stack that V8 wrote, as opposed to the ones the message did.
 *
 * `Error#stack` is `${name}: ${message}` followed by the frames, and nothing in
 * the string marks where one ends and the other starts: a message carrying
 * `"\n    at f (/app/dist/config.js:1:1)"` - a request parameter interpolated
 * into a validation or driver error is enough - reads as a frame, and sits
 * above the real ones. So the boundary is taken from the error itself: the
 * message has to be found on the stack's first line and run to the end of a
 * line, and only the unbroken run of frame lines directly after it counts.
 * That run also ends before anything appended later (`Caused by: ...`), which
 * is one more message.
 *
 * Fails closed. An error whose message was reassigned after construction no
 * longer matches its own stack and gets no code frames, which costs a nicety;
 * guessing the boundary instead is what the paragraph above is about.
 *
 * With `message` undefined the whole string is treated as frames - only for a
 * stack the caller wrote itself.
 */
function frameLines(stack: string, message: string | undefined): string[] {
  if (message === undefined) {
    return stack.split("\n", MAX_FRAME_LINES);
  }

  let headerEnd: number;
  if (message === "") {
    headerEnd = stack.indexOf("\n");
  } else {
    const at = stack.indexOf(message);
    if (at === -1 || stack.lastIndexOf("\n", at) !== -1) {
      return [];
    }
    headerEnd = at + message.length;
  }
  if (headerEnd === -1 || stack[headerEnd] !== "\n") {
    return [];
  }

  const lines: string[] = [];
  for (const line of stack.slice(headerEnd + 1).split("\n", MAX_FRAME_LINES)) {
    if (!FRAME_PREFIX.test(line)) {
      break;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Reads one V8 frame line, in either shape:
 *   at fn (/abs/path/file.ts:42:31)
 *   at /abs/path/file.ts:42:31
 *
 * Taken apart by index rather than by one pattern. The pattern this replaces
 * had two lazy groups that could each claim the same text, which made a line
 * with no position quadratic to reject - seconds of event loop for a 100KB
 * line, and the line came from whoever wrote the error message.
 */
function parseFrameLine(raw: string): ParsedFrame | undefined {
  if (raw.length > MAX_FRAME_LINE_LENGTH) {
    return undefined;
  }
  const prefix = FRAME_PREFIX.exec(raw);
  if (!prefix) {
    return undefined;
  }

  let location = raw.slice(prefix[0].length).trimEnd();
  if (location.endsWith(")")) {
    const open = location.indexOf(" (");
    if (open !== -1) {
      location = location.slice(open + 2, -1);
    }
  }

  const columnAt = location.lastIndexOf(":");
  const lineAt = location.lastIndexOf(":", columnAt - 1);
  if (lineAt <= 0) {
    return undefined;
  }
  const line = location.slice(lineAt + 1, columnAt);
  const column = location.slice(columnAt + 1);
  if (!/^\d+$/.test(line) || !/^\d+$/.test(column)) {
    return undefined;
  }

  return {
    file: location.slice(0, lineAt),
    line: Number(line),
    column: Number(column),
  };
}

function parseFrames(
  stack: string,
  message: string | undefined,
): ParsedFrame[] {
  const frames: ParsedFrame[] = [];

  for (const raw of frameLines(stack, message)) {
    const parsed = parseFrameLine(raw);
    if (!parsed) {
      continue;
    }

    const { file, line, column } = parsed;
    if (isIgnored(file)) {
      continue;
    }

    // Only absolute paths can be read back off disk. Anything else (an eval
    // frame, a bundled virtual path) has no file to open.
    if (!file.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(file)) {
      continue;
    }

    if (!isReadableSourcePath(file)) {
      continue;
    }

    frames.push({ file, line, column });
  }

  return frames;
}

function readSource(file: string): string[] | null {
  if (sourceCache.has(file)) {
    return sourceCache.get(file)!;
  }

  let lines: string[] | null = null;
  try {
    // The path was checked as written; what gets opened is where it leads. A
    // symlink under the root - `current -> /releases/42`, or something less
    // innocent - passes a lexical check while pointing anywhere, so the
    // resolved path has to clear the same gate. The root is resolved too: a
    // working directory reached through a link is otherwise outside itself.
    const real = realpathSync(file);
    if (isReadableSourcePath(real, realpathSync(process.cwd()))) {
      lines = readFileSync(real, "utf8").split("\n");
    }
  } catch {
    // Unreadable for any reason - bundled away, permissions, deleted since
    // build. Cached as a miss so it is not retried on the next throw.
    lines = null;
  }

  if (sourceCache.size >= MAX_CACHED_FILES) {
    const oldest = sourceCache.keys().next().value;
    if (oldest !== undefined) {
      sourceCache.delete(oldest);
    }
  }
  sourceCache.set(file, lines);
  return lines;
}

/**
 * Reads source around each in-app frame of a stack trace.
 *
 * Only the machine running the code can read its own files, so this has to happen
 * agent-side at throw time - the position in a frame is already exact (the app
 * runs with source-map support, so frames resolve to TypeScript), but the file
 * contents are not something the server can recover.
 *
 * Deliberately bounded: in-app frames only, a handful of lines either side, and a
 * cap on how many frames are attached, because whatever this returns is shipped to
 * the server and stored in the telemetry database.
 *
 * Never throws - source context is a nicety and must not be able to break the
 * request that was already failing.
 */
export function collectCodeFrames(
  stack: string | undefined,
  options: {
    linesOfContext?: number;
    maxFrames?: number;
    sourceMaps?: boolean;
    /**
     * The error's own `message`, which is how the frames are told apart from
     * message text that looks like one - see `frameLines`. Always pass it for
     * a stack that came off an error.
     */
    message?: string;
  } = {},
): CodeFrame[] | undefined {
  if (!stack) {
    return undefined;
  }

  const linesOfContext = options.linesOfContext ?? DEFAULT_LINES_OF_CONTEXT;
  if (linesOfContext < 0) {
    throw new Error("linesOfContext must be non-negative");
  }
  if (options.maxFrames !== undefined && options.maxFrames < 0) {
    throw new Error("maxFrames must be non-negative");
  }
  if (
    options.sourceMaps !== undefined &&
    typeof options.sourceMaps !== "boolean"
  ) {
    throw new Error("sourceMaps must be a boolean");
  }
  if (linesOfContext > MAX_LINES_OF_CONTEXT) {
    throw new Error(`linesOfContext must not exceed ${MAX_LINES_OF_CONTEXT}`);
  }
  if (options.maxFrames !== undefined && options.maxFrames > MAX_FRAMES) {
    throw new Error(`maxFrames must not exceed ${MAX_FRAMES}`);
  }
  const maxFrames = options.maxFrames ?? 5;

  try {
    const frames = parseFrames(stack, options.message).slice(0, maxFrames);
    const codeFrames: CodeFrame[] = [];

    for (const frame of frames) {
      let file = frame.file;
      let line = frame.line;
      let source: string[] | null = null;

      if (options.sourceMaps) {
        const original = resolveOriginalPosition(
          frame.file,
          frame.line,
          frame.column,
        );
        if (original) {
          // Re-apply the in-app filter to the mapped path: a frame in
          // dist/main.js can map back into node_modules, and that is still noise.
          if (isIgnored(original.file)) {
            continue;
          }
          // And the containment check, when the map's `sources` entry is about
          // to be read from disk rather than taken from `sourcesContent`. The
          // compiled frame passed it; the path the map resolved it to is a
          // different string from a different input, and a map is one more
          // thing on disk that can say `../../../etc/passwd`.
          if (!original.content && !isReadableSourcePath(original.file)) {
            continue;
          }
          file = original.file;
          line = original.line;
          // Prefer the map's embedded copy - it is the source this build was
          // compiled from, and it works when the source tree is not deployed.
          source = original.content ?? null;
        }
      }

      source ??= readSource(file);
      if (!source) {
        continue;
      }

      if (line > source.length) {
        // Position does not fit the file - stale build against changed source.
        continue;
      }

      // Frame lines are 1-based; array indices are 0-based.
      const firstLine = Math.max(1, line - linesOfContext);
      const lastLine = Math.min(source.length, line + linesOfContext);

      codeFrames.push({
        file,
        line,
        firstLine,
        lines: source.slice(firstLine - 1, lastLine),
      });
    }

    return codeFrames.length ? codeFrames : undefined;
  } catch {
    return undefined;
  }
}
