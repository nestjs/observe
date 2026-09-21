import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join, relative } from "path";
import { collectCodeFrames } from "./source-context.util.js";
import { resetSourceMapCache } from "./source-map-resolver.util.js";

/**
 * Code frames are read off the host's disk and shipped, so the one property
 * that matters here is which files that can ever be. The frame path is gated
 * on the way in; these check that the path a source map redirects it to is
 * gated the same way, since the map is a second input that can name any file.
 */
describe("collectCodeFrames with source maps", () => {
  // Under the working directory, because that is the containment root: only
  // a compiled file inside it is eligible to have its map read at all.
  let inside: string;
  // Outside it: where a map must not be able to reach.
  let outside: string;

  beforeAll(() => {
    inside = mkdtempSync(join(process.cwd(), ".tmp-source-context-"));
    outside = mkdtempSync(join(tmpdir(), "observe-source-context-"));
  });

  afterAll(() => {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  beforeEach(() => resetSourceMapCache());

  /**
   * A one-line compiled file whose map sends line 1 to line 1 of `source`.
   * "AAAA" is the one VLQ segment that does exactly that.
   */
  const compile = (name: string, source: string, sourcesContent?: string[]) => {
    const dir = join(inside, name);
    mkdirSync(dir);
    const compiled = join(dir, "main.js");
    writeFileSync(
      compiled,
      `throw new Error("boom");\n//# sourceMappingURL=main.js.map\n`,
    );
    writeFileSync(
      join(dir, "main.js.map"),
      JSON.stringify({
        version: 3,
        sources: [source],
        names: [],
        mappings: "AAAA",
        ...(sourcesContent ? { sourcesContent } : {}),
      }),
    );
    return compiled;
  };

  const stackAt = (compiled: string) =>
    `Error: boom\n    at run (${compiled}:1:1)`;

  it("reads a mapped source that lives under the working directory", () => {
    const compiled = compile("in-tree", "./main.ts");
    writeFileSync(
      join(inside, "in-tree", "main.ts"),
      "const x = 1;\nthrow new Error('boom');\n",
    );

    const frames = collectCodeFrames(stackAt(compiled), { sourceMaps: true });

    expect(frames).toHaveLength(1);
    expect(basename(frames![0].file)).toBe("main.ts");
    expect(frames![0].lines[0]).toBe("const x = 1;");
  });

  it("refuses to read a mapped source outside the working directory", () => {
    const secret = join(outside, "secret.ts");
    writeFileSync(secret, "TOP SECRET\n");
    // A relative path, as a map's `sources` would carry it - and one that
    // clears the extension allowlist, so containment is the only thing left.
    const compiled = compile(
      "escape",
      relative(join(inside, "escape"), secret).split("\\").join("/"),
    );

    const frames = collectCodeFrames(stackAt(compiled), { sourceMaps: true });

    expect(JSON.stringify(frames ?? [])).not.toContain("TOP SECRET");
    expect(frames).toBeUndefined();
  });

  it("still uses embedded source for a path outside the working directory", () => {
    // `sourcesContent` is the build's own copy of the source - nothing is read
    // from disk, so there is nothing to contain. A container shipping only
    // dist depends on this path.
    const compiled = compile("embedded", "../../../elsewhere/main.ts", [
      "const embedded = true;\n",
    ]);

    const frames = collectCodeFrames(stackAt(compiled), { sourceMaps: true });

    expect(frames).toHaveLength(1);
    expect(frames![0].lines[0]).toBe("const embedded = true;");
  });
});

/**
 * A stack is message plus frames, and the message is routinely built from
 * request input. These pin down that only what V8 wrote is read as a frame.
 */
describe("collectCodeFrames on a stack with an untrusted message", () => {
  let inside: string;
  let outside: string;
  let secret: string;

  beforeAll(() => {
    inside = mkdtempSync(join(process.cwd(), ".tmp-source-context-"));
    outside = mkdtempSync(join(tmpdir(), "observe-source-context-"));
    secret = join(inside, "secrets.js");
    writeFileSync(secret, "module.exports = {};\n");
  });

  afterAll(() => {
    rmSync(inside, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const forged = () => `x\n    at f (${secret}:1:1)`;
  const collect = (error: Error) =>
    collectCodeFrames(error.stack, { message: error.message });
  const files = (frames: ReturnType<typeof collectCodeFrames>) =>
    (frames ?? []).map((frame) => basename(frame.file));

  it("does not read a frame that the message spelled out", () => {
    const frames = collect(new Error(`Invalid id: ${forged()}`));

    expect(files(frames)).not.toContain("secrets.js");
    // The real frames - this file - are still read.
    expect(files(frames)).toContain("source-context.util.spec.ts");
  });

  it("does not read one from a quoted value that closes on its own line", () => {
    // The shape a driver error takes: `invalid input syntax for type uuid: "<value>"`.
    const frames = collect(new Error(`invalid input: "${forged()}\n"`));

    expect(files(frames)).not.toContain("secrets.js");
  });

  it("stops at text appended after the frames", () => {
    const error = new Error("outer");
    error.stack += `\nCaused by: Error: ${forged()}`;

    expect(files(collect(error))).not.toContain("secrets.js");
  });

  it("reads nothing when the message no longer matches the stack", () => {
    const error = new Error(`Invalid id: ${forged()}`);
    // Read first: a runtime with `prepareStackTrace` installed formats the
    // stack on first access, and the header is fixed from then on.
    void error.stack;
    error.message = "Invalid id";

    expect(collect(error)).toBeUndefined();
  });

  it("reads the frames of an error with no message", () => {
    expect(collect(new Error())?.[0].file).toContain(
      "source-context.util.spec",
    );
  });

  it("rejects a pathological line in linear time", () => {
    // Quadratic under the pattern this replaced: ~3s for this input.
    const line = "    at " + " (".repeat(50_000) + "x";
    const startedAt = performance.now();

    collectCodeFrames(`Error: boom\n${line}`);

    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("does not follow a symlink out of the working directory", () => {
    const target = join(outside, "target.ts");
    writeFileSync(target, "TOP SECRET\n");
    const link = join(inside, "link.ts");
    symlinkSync(target, link);

    const frames = collectCodeFrames(`Error: boom\n    at run (${link}:1:1)`, {
      message: "boom",
    });

    expect(frames).toBeUndefined();
  });
});
