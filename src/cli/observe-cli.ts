#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { link } from "./link.js";
import { openUrl } from "./open-url.js";
import { loadTypeScript } from "./project-setup.js";

const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

const HOSTED_COLLECTOR_ENDPOINT = "https://observe-api.nestjs.com";

const USAGE = `Usage: npx @nestjs/observe link [--no-browser] [--cwd <dir>]

  link    Link this project to NestJS Observe: approve a code in the
          dashboard, and the API key pair is written into .env. In an app
          that does not use the SDK yet, it is installed and wired in too.

Options:
  --no-browser    Print the link page instead of opening it.
  --cwd <dir>     The project directory (default: the current one).`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "link") {
    console.log(USAGE);
    return command === undefined || command === "--help" || command === "-h"
      ? 0
      : 1;
  }

  const cwdIndex = rest.indexOf("--cwd");
  const cwd = resolve(cwdIndex >= 0 ? rest[cwdIndex + 1] ?? "." : ".");
  const interactive = process.stdout.isTTY && !process.env.CI;

  return link(
    {
      cwd,
      endpoint: (
        process.env.OBSERVE_ENDPOINT ?? HOSTED_COLLECTOR_ENDPOINT
      ).replace(/\/+$/, ""),
      openBrowser: interactive && !rest.includes("--no-browser"),
      version,
    },
    {
      fetch,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      openUrl,
      log: (line) => console.log(line),
      hostname,
      now: Date.now,
      run,
      loadTypeScript,
    },
  );
}

/**
 * Runs the package manager with the terminal attached. On Windows through the
 * shell, which is what finds `npm.cmd`; there `^` is cmd.exe's escape
 * character, so each argument is quoted.
 */
function run(command: string, args: string[], cwd: string): Promise<number> {
  const windows = process.platform === "win32";
  return new Promise((done) => {
    const child = spawn(
      command,
      windows ? args.map((arg) => `"${arg}"`) : args,
      { cwd, stdio: "inherit", shell: windows },
    );
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code ?? -1));
  });
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
