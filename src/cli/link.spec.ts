import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { link, LinkDependencies } from "./link.js";

const STARTED = {
  deviceCode: "device-code",
  userCode: "BCDF-GHJK",
  verificationUri: "https://observe.nestjs.com/link",
  expiresIn: 900,
  interval: 5,
};

const LINKED = {
  appKey: "kK$kK&kKkKkKkKkKk",
  appSecret: "s3cr$t^with&dollars",
  projectId: "p",
  projectName: "Storefront",
  applicationId: "a",
  applicationName: "orders-api",
};

/**
 * A scripted API: `sessions` once, then each poll answers the next reply. The
 * package manager exits with `installExit`, adding the SDK to package.json
 * when that is 0, as a real install would.
 */
function harness(
  polls: Array<{ status: number; body: unknown } | "network">,
  { installExit = 0 }: { installExit?: number } = {},
) {
  const lines: string[] = [];
  const opened: string[] = [];
  const requests: Array<{ url: string; body: unknown }> = [];
  const sleeps: number[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];
  let clock = 0;
  const replies = [...polls];

  const deps: LinkDependencies = {
    fetch: (async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(init?.body as string) });
      if (url.endsWith("/cli-link/sessions")) {
        return new Response(JSON.stringify(STARTED), { status: 201 });
      }
      const reply = replies.shift() ?? {
        status: 400,
        body: { error: "authorization_pending" },
      };
      if (reply === "network") {
        throw new TypeError("fetch failed");
      }
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    openUrl: (url) => opened.push(url),
    log: (line) => lines.push(line),
    hostname: () => "kamils-mbp",
    now: () => clock,
    run: async (command, args, cwd) => {
      commands.push({ command, args });
      if (installExit === 0) {
        const path = join(cwd, "package.json");
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        pkg.dependencies = {
          ...pkg.dependencies,
          "@nestjs/observe": "^0.3.16",
        };
        writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
      }
      return installExit;
    },
    loadTypeScript: () => ts,
  };
  return { deps, lines, opened, requests, sleeps, commands };
}

const pending = { status: 400, body: { error: "authorization_pending" } };

/** `nest new` with Observe: already instrumented, waiting for its key. */
const OBSERVED_MODULE = `import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'orders-api',
    }),
  ],
})
export class AppModule {}
`;

const OBSERVED_MAIN = `import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    instrument: ObserveInstrument,
  });
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
`;

/** An app that has never heard of Observe. */
const PLAIN_MODULE = `import { Module } from '@nestjs/common';
import { AppController } from './app.controller';

@Module({
  imports: [],
  controllers: [AppController],
})
export class AppModule {}
`;

const PLAIN_MAIN = `import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
`;

describe("npx @nestjs/observe link", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-link-"));
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "orders-api",
          // What `nest new` generates with Observe, plus a script that is
          // not a start.
          dependencies: {
            "@nestjs/common": "^11.1.6",
            "@nestjs/core": "^11.1.6",
            "@nestjs/observe": "^0.3.15",
          },
          scripts: {
            build: "nest build",
            start: "nest start",
            "start:dev": "nest start --watch",
            "start:debug": "nest start --debug --watch",
            "start:prod": "node dist/main",
            lint: "eslint src",
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n.env\n");
    write("src/app.module.ts", OBSERVED_MODULE);
    write("src/main.ts", OBSERVED_MAIN);
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  const read = (path: string) => readFileSync(join(cwd, path), "utf8");

  const run = (h: ReturnType<typeof harness>, openBrowser = true) =>
    link(
      { cwd, endpoint: "https://api.test", openBrowser, version: "0.3.16" },
      h.deps,
    );

  it("writes the approved pair into .env and loads it in the start scripts", async () => {
    const h = harness([pending, { status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(
      "OBSERVE_APP_KEY='kK$kK&kKkKkKkKkKk'\nOBSERVE_APP_SECRET='s3cr$t^with&dollars'\n",
    );
    // Owner-only: it holds a secret.
    expect(statSync(join(cwd, ".env")).mode & 0o777).toBe(0o600);
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    expect(pkg.scripts).toEqual({
      build: "nest build",
      start: "nest start --env-file .env",
      "start:dev": "nest start --watch --env-file .env",
      // A debugging session reports too.
      "start:debug": "nest start --debug --watch --env-file .env",
      // Production loads its environment from the platform, not a file.
      "start:prod": "node dist/main",
      lint: "eslint src",
    });
    expect(h.lines).toContain(
      '  "start", "start:dev" and "start:debug" now load it with --env-file .env.',
    );
    expect(h.requests[0].body).toEqual({
      applicationName: "orders-api",
      hostname: "kamils-mbp",
    });
    expect(h.lines).toContain("  and type  BCDF-GHJK");
    // The page, never the code: the code is what the person types.
    expect(h.opened).toEqual(["https://observe.nestjs.com/link"]);
    // Instrumented already: nothing installed, the code left as it was.
    expect(h.commands).toEqual([]);
    expect(read("src/app.module.ts")).toBe(OBSERVED_MODULE);
    expect(h.lines.at(-1)).toBe(
      "  Start the app and it reports to NestJS Observe. In production, set OBSERVE_APP_KEY and OBSERVE_APP_SECRET in the environment instead.",
    );
  });

  it("replaces an earlier pair and keeps the rest of .env", async () => {
    writeFileSync(
      join(cwd, ".env"),
      "DATABASE_URL=postgres://x\nOBSERVE_APP_KEY=old\nOBSERVE_APP_SECRET='old'\nPORT=3000\n",
    );
    const h = harness([{ status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(readFileSync(join(cwd, ".env"), "utf8")).toBe(
      "DATABASE_URL=postgres://x\nPORT=3000\n\nOBSERVE_APP_KEY='kK$kK&kKkKkKkKkKk'\nOBSERVE_APP_SECRET='s3cr$t^with&dollars'\n",
    );
  });

  it("does not add --env-file twice, and git-ignores .env when it was not", async () => {
    writeFileSync(join(cwd, ".gitignore"), "node_modules");
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.scripts.start = "nest start --env-file .env.local";
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    const h = harness([{ status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(
      "node_modules\n\n# NestJS Observe key pair\n.env\n",
    );
    const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts;
    expect(scripts.start).toBe("nest start --env-file .env.local");
    expect(scripts["start:dev"]).toBe("nest start --watch --env-file .env");
  });

  it("backs off when asked to slow down, and rides out a network blip", async () => {
    const h = harness([
      { status: 400, body: { error: "slow_down" } },
      "network",
      { status: 200, body: LINKED },
    ]);

    expect(await run(h)).toBe(0);
    expect(h.sleeps).toEqual([5000, 10000, 10000]);
  });

  it.each([
    ["access_denied", /denied in the dashboard/],
    ["expired_token", /expired before it was approved/],
  ])("writes nothing when the link ends with %s", async (error, message) => {
    const h = harness([pending, { status: 400, body: { error } }]);

    expect(await run(h)).toBe(1);
    expect(h.lines.at(-1)).toMatch(message);
    expect(() => readFileSync(join(cwd, ".env"))).toThrow();
    expect(
      JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).scripts.start,
    ).toBe("nest start");
  });

  it("gives up at the code's own expiry while still pending", async () => {
    const h = harness([]);

    expect(await run(h)).toBe(1);
    expect(h.lines.at(-1)).toMatch(/expired before it was approved/);
    // 900 s at a 5 s interval.
    expect(h.sleeps).toHaveLength(180);
  });

  it("tells coding agents where the production data is, without a word on the console", async () => {
    const h = harness([pending, { status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(read("AGENTS.md")).toContain("## Production data: NestJS Observe");
    expect(
      h.lines.some((line) => /AGENTS\.md|CLAUDE\.md|coding agents/.test(line)),
    ).toBe(false);
  });

  it("leaves AGENTS.md alone, and says nothing of it, once it has the notes", async () => {
    write(
      "AGENTS.md",
      "# AGENTS.md\n\n## Production data: NestJS Observe\n\nOurs.\n",
    );
    const h = harness([pending, { status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(read("AGENTS.md")).toBe(
      "# AGENTS.md\n\n## Production data: NestJS Observe\n\nOurs.\n",
    );
    expect(h.lines.some((line) => line.includes("AGENTS.md"))).toBe(false);
  });

  it("refuses to run outside a project", async () => {
    rmSync(join(cwd, "package.json"));
    const h = harness([]);

    expect(await run(h)).toBe(1);
    expect(h.requests).toHaveLength(0);
  });

  it("loads .env in a monorepo's nest start scripts too, and says which start does not", async () => {
    const pkgPath = join(cwd, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify({
        name: "platform",
        dependencies: {
          "@nestjs/core": "^11.1.6",
          "@nestjs/observe": "^0.3.15",
        },
        scripts: {
          start: "node --env-file=.env.local dist/main",
          "start:dev": "nodemon",
          "start:worker": "nest start worker --watch",
        },
      }),
    );
    const h = harness([{ status: 200, body: LINKED }]);

    expect(await run(h)).toBe(0);

    expect(JSON.parse(readFileSync(pkgPath, "utf8")).scripts).toEqual({
      // Already loads an env file of its own: left as it is, and not reported.
      start: "node --env-file=.env.local dist/main",
      "start:dev": "nodemon",
      "start:worker": "nest start worker --watch --env-file .env",
    });
    expect(h.lines).toContain(
      '  "start:dev" does not run nest start, so load .env there yourself (node --env-file=.env).',
    );
  });

  describe("in an app that does not use the SDK yet", () => {
    beforeEach(() => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      delete pkg.dependencies["@nestjs/observe"];
      writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
      write("src/app.module.ts", PLAIN_MODULE);
      write("src/main.ts", PLAIN_MAIN);
    });

    it("installs the SDK and wires it in, having said so before the approval", async () => {
      const h = harness([pending, { status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      expect(h.commands).toEqual([
        { command: "npm", args: ["install", "@nestjs/observe@^0.3.16"] },
      ]);
      const module = read("src/app.module.ts");
      expect(module).toContain(
        "export const { ObserveModule, ObserveInstrument } = createObserveModule();",
      );
      // Named after the application it was approved for, as the dashboard
      // would tell someone setting it up by hand.
      expect(module).toContain("serviceId: 'orders-api',");
      expect(read("src/main.ts")).toContain("instrument: ObserveInstrument,");

      const plan = h.lines.indexOf(
        "This project does not use NestJS Observe yet: once you approve, link also installs @nestjs/observe with npm and wires it into the app's root module and main.ts.",
      );
      const linked = h.lines.findIndex((line) => line.startsWith("✔ Linked"));
      expect(plan).toBeGreaterThan(-1);
      expect(plan).toBeLessThan(linked);
      expect(h.lines).toContain("✔ Installed @nestjs/observe@^0.3.16.");
      expect(h.lines).toContain("✔ Wired it into the app:");
      expect(h.lines).toContain(
        "    src/main.ts        passes ObserveInstrument to NestFactory.create()",
      );
      expect(h.lines.at(-1)).toMatch(/^ {2}Start the app and it reports/);
    });

    it("installs with the package manager the project uses", async () => {
      writeFileSync(join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);
      expect(h.commands).toEqual([
        { command: "pnpm", args: ["add", "@nestjs/observe@^0.3.16"] },
      ]);
    });

    it("leaves the code alone when the install fails, and says what to run", async () => {
      const h = harness([{ status: 200, body: LINKED }], { installExit: 1 });

      expect(await run(h)).toBe(1);

      expect(read("src/app.module.ts")).toBe(PLAIN_MODULE);
      expect(read("src/main.ts")).toBe(PLAIN_MAIN);
      // The key is still where it is used from.
      expect(read(".env")).toContain("OBSERVE_APP_KEY=");
      expect(h.lines.at(-1)).toBe(
        "✖ npm install @nestjs/observe@^0.3.16 did not finish. Run it yourself, then add the SDK to the app: https://observe.nestjs.com/documentation/sdk#quick-start",
      );
    });

    it("wires an installed SDK in without installing it again", async () => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.dependencies["@nestjs/observe"] = "^0.3.16";
      writeFileSync(path, JSON.stringify(pkg));
      write(
        "node_modules/@nestjs/observe/package.json",
        JSON.stringify({ name: "@nestjs/observe", version: "0.3.16" }),
      );
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      expect(h.commands).toEqual([]);
      expect(h.lines).toContain(
        "The app does not use @nestjs/observe yet: once you approve, link also wires it into the app's root module and main.ts.",
      );
      expect(read("src/main.ts")).toContain("instrument: ObserveInstrument,");
    });

    it("upgrades an installed SDK older than the wiring before wiring it in", async () => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      pkg.dependencies["@nestjs/observe"] = "^0.3.14";
      writeFileSync(path, JSON.stringify(pkg));
      write(
        "node_modules/@nestjs/observe/package.json",
        JSON.stringify({ name: "@nestjs/observe", version: "0.3.14" }),
      );
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);
      expect(h.commands).toEqual([
        { command: "npm", args: ["install", "@nestjs/observe@^0.3.16"] },
      ]);
    });

    it("leaves a workspace's wiring to the person: the key is for one application", async () => {
      write(
        "nest-cli.json",
        JSON.stringify({
          monorepo: true,
          sourceRoot: "apps/orders/src",
          projects: {
            orders: { type: "application", root: "apps/orders" },
            billing: { type: "application", root: "apps/billing" },
            shared: { type: "library", root: "libs/shared" },
          },
        }),
      );
      write("apps/orders/src/main.ts", PLAIN_MAIN);
      write("apps/orders/src/app.module.ts", PLAIN_MODULE);
      write("apps/billing/src/main.ts", PLAIN_MAIN);
      write("apps/billing/src/app.module.ts", PLAIN_MODULE);
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      expect(read("apps/orders/src/app.module.ts")).toBe(PLAIN_MODULE);
      expect(h.lines).toContain(
        "! Not wired into the app: this workspace has 2 applications (apps/orders/src/main.ts, apps/billing/src/main.ts), and the key is for one of them.",
      );
      expect(h.lines.at(-1)).toMatch(/^ {2}Once it is wired, start the app/);
    });

    it.each([
      [
        "a NestJS older than the SDK supports",
        { "@nestjs/core": "^10.4.15" },
        "NestJS Observe needs NestJS 11 or later, and this project has @nestjs/core ^10.4.15. Upgrade NestJS first. Nothing was written.",
      ],
      [
        "a folder that is not a NestJS project",
        {},
        "This does not look like a NestJS project: package.json has no @nestjs/core. Nothing was written.",
      ],
    ])(
      "turns away %s before asking for a code",
      async (_, dependencies, message) => {
        const path = join(cwd, "package.json");
        const pkg = JSON.parse(readFileSync(path, "utf8"));
        pkg.dependencies = dependencies;
        writeFileSync(path, JSON.stringify(pkg));
        const h = harness([]);

        expect(await run(h)).toBe(1);

        expect(h.requests).toHaveLength(0);
        expect(h.lines).toEqual([message]);
      },
    );
  });
});
