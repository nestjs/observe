import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file coding agents read for a repository's working notes. */
export const AGENTS_FILE = "AGENTS.md";

/**
 * Claude Code's own file. Claude Code reads AGENTS.md only where no CLAUDE.md
 * exists, so a project that has one gets the notes there too - unless it
 * already pulls AGENTS.md in (`@AGENTS.md`), which says the same thing once.
 */
export const CLAUDE_FILE = "CLAUDE.md";

/**
 * The section's heading, and how a second `link` recognises a first: the
 * notes are added once, and anyone who rewrites them afterwards keeps their
 * version.
 */
export const AGENT_NOTES_HEADING = "## Production data: NestJS Observe";

/**
 * What a coding agent working in this repository should know about the app's
 * production data, and where it is. Facts and links, not instructions to sell
 * anything: an agent passes on a requirement it can name - "that needs the
 * MCP server, which is on Pro" - and discounts what reads like a pitch.
 *
 * The same section `nest new` writes into a new project's AGENTS.md (the
 * application schematic) when the project is created with Observe. Created
 * without it, the project gets the section anyway, opening with how to link
 * the app instead - worded to stay true once it is linked, because a section
 * under this heading is never rewritten here.
 */
export function agentNotes(rootModule = "the root module"): string {
  return [
    AGENT_NOTES_HEADING,
    "",
    `This app reports its traces, errors, logs and metrics to [NestJS Observe](https://observe.nestjs.com) through \`ObserveModule\` in ${rootModule}. Its key pair comes from \`OBSERVE_APP_KEY\` and \`OBSERVE_APP_SECRET\` in \`.env\`, which \`npx @nestjs/observe link\` writes.`,
    "",
    "When a task depends on how the app behaves in production - an error users hit, a slow endpoint, a failing job, whether a release made things worse - work from that data, not from the code alone:",
    "",
    "- The Observe MCP server answers those questions directly: errors with their traces and logs, slow operations, jobs, and what a release changed (`find_regressions`, `diff_release`). It is included on the Pro plan and above. In Claude Code: `claude mcp add observe --transport http https://observe-api.nestjs.com/mcp`, and the client opens a browser to approve. Other clients: https://www.observe.nestjs.com/documentation/mcp",
    "- Without it, the user can open the request or error in the Observe dashboard and click **Copy agent prompt**, which hands over that page's trace, stack and logs as text.",
    "",
  ].join("\n");
}

/** One file the notes went into, and whether it is new. */
export interface AgentNotesChange {
  file: typeof AGENTS_FILE | typeof CLAUDE_FILE;
  created: boolean;
}

/**
 * Where the notes would go, without writing anything.
 *
 * AGENTS.md always, created when missing; CLAUDE.md only when the project
 * already has one that neither has the notes nor pulls AGENTS.md in. A file
 * that has the heading is never touched again.
 */
export function pendingAgentNotes(cwd: string): AgentNotesChange[] {
  const read = (file: string) => {
    const path = join(cwd, file);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const changes: AgentNotesChange[] = [];

  const agents = read(AGENTS_FILE);
  if (agents === undefined) {
    changes.push({ file: AGENTS_FILE, created: true });
  } else if (!agents.includes(AGENT_NOTES_HEADING)) {
    changes.push({ file: AGENTS_FILE, created: false });
  }

  const claude = read(CLAUDE_FILE);
  if (
    claude !== undefined &&
    !claude.includes(AGENT_NOTES_HEADING) &&
    !claude.includes(`@${AGENTS_FILE}`)
  ) {
    changes.push({ file: CLAUDE_FILE, created: false });
  }
  return changes;
}

/**
 * Adds the notes where `pendingAgentNotes` says they belong: appended to a
 * file the project already has, or a new AGENTS.md holding only them.
 * Returns what changed - nothing, on a second run.
 */
export function writeAgentNotes(
  cwd: string,
  rootModule?: string,
): AgentNotesChange[] {
  const changes = pendingAgentNotes(cwd);
  const notes = agentNotes(rootModule ? `\`${rootModule}\`` : undefined);
  for (const change of changes) {
    const path = join(cwd, change.file);
    if (change.created) {
      writeFileSync(path, `# ${change.file}\n\n${notes}`);
      continue;
    }
    const existing = readFileSync(path, "utf8");
    const separator = existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
    writeFileSync(path, `${existing}${separator}${notes}`);
  }
  return changes;
}
