import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_NOTES_HEADING,
  agentNotes,
  pendingAgentNotes,
  writeAgentNotes,
} from "./agent-notes.js";

describe("notes for coding agents", () => {
  let cwd: string;
  const read = (file: string) => readFileSync(join(cwd, file), "utf8");
  const write = (file: string, text: string) =>
    writeFileSync(join(cwd, file), text);

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-agent-notes-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates AGENTS.md when the project has none", () => {
    expect(writeAgentNotes(cwd, "src/app.module.ts")).toEqual([
      { file: "AGENTS.md", created: true },
    ]);

    const content = read("AGENTS.md");
    expect(content.startsWith("# AGENTS.md\n\n")).toBe(true);
    expect(content).toContain(AGENT_NOTES_HEADING);
    expect(content).toContain("`ObserveModule` in `src/app.module.ts`");
  });

  it("appends to the project's own AGENTS.md and keeps it as it was", () => {
    const own = "# AGENTS.md\n\nUse pnpm. Never touch migrations.";
    write("AGENTS.md", own);

    expect(writeAgentNotes(cwd)).toEqual([
      { file: "AGENTS.md", created: false },
    ]);

    const content = read("AGENTS.md");
    expect(content.startsWith(`${own}\n\n${AGENT_NOTES_HEADING}`)).toBe(true);
    // Not wired by link: the module is described, not guessed.
    expect(content).toContain("`ObserveModule` in the root module");
  });

  it("adds them to CLAUDE.md too, which Claude Code reads instead of AGENTS.md", () => {
    write("CLAUDE.md", "# Project notes\n\nRun the linter.\n");

    expect(writeAgentNotes(cwd)).toEqual([
      { file: "AGENTS.md", created: true },
      { file: "CLAUDE.md", created: false },
    ]);
    expect(read("CLAUDE.md")).toBe(
      `# Project notes\n\nRun the linter.\n\n${agentNotes()}`,
    );
  });

  it("leaves a CLAUDE.md that already pulls AGENTS.md in", () => {
    write("CLAUDE.md", "@AGENTS.md\n\nClaude-specific notes.\n");

    expect(writeAgentNotes(cwd)).toEqual([
      { file: "AGENTS.md", created: true },
    ]);
    expect(read("CLAUDE.md")).toBe("@AGENTS.md\n\nClaude-specific notes.\n");
  });

  it("adds them once, and leaves a version someone rewrote alone", () => {
    write("CLAUDE.md", "# Notes\n");
    writeAgentNotes(cwd);
    const rewritten = read("AGENTS.md").replace(
      "Pro plan and above",
      "our Pro plan",
    );
    write("AGENTS.md", rewritten);
    const claude = read("CLAUDE.md");

    expect(pendingAgentNotes(cwd)).toEqual([]);
    expect(writeAgentNotes(cwd)).toEqual([]);
    expect(read("AGENTS.md")).toBe(rewritten);
    expect(read("CLAUDE.md")).toBe(claude);
  });

  it("states the requirement and the way in, as facts", () => {
    const notes = agentNotes();

    expect(notes).toContain("Pro plan and above");
    expect(notes).toContain(
      "claude mcp add observe --transport http https://observe-api.nestjs.com/mcp",
    );
    expect(notes).toContain("https://www.observe.nestjs.com/documentation/mcp");
    expect(notes).toContain("Copy agent prompt");
  });
});
