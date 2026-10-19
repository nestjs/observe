import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A scripted API: `sessions` once, then each poll answers the next reply. */
function harness(polls: Array<{ status: number; body: unknown } | "network">) {
  const lines: string[] = [];
  const opened: string[] = [];
  const requests: Array<{ url: string; body: unknown }> = [];
  const sleeps: number[] = [];
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
  };
  return { deps, lines, opened, requests, sleeps };
}

const pending = { status: 400, body: { error: "authorization_pending" } };

/** The AppModule `nest new` scaffolds with Observe. */
const SCAFFOLDED_APP_MODULE = `import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller';
import { AppService } from './app.service';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: 'YOUR_APP_KEY',
      appSecret: 'YOUR_APP_SECRET',
      serviceId: 'orders-api',
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
`;

/** An installed `@nestjs/observe`, as far as its declarations go. */
function installSdk(cwd: string, appKeyDeclaration: string) {
  const root = join(cwd, "node_modules", "@nestjs", "observe");
  mkdirSync(join(root, "dist", "interfaces"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@nestjs/observe",
      exports: { ".": "./dist/index.js", "./package.json": "./package.json" },
    }),
  );
  writeFileSync(
    join(root, "dist", "interfaces", "observe-options.interface.d.ts"),
    `export interface ObserveOptions {\n    ${appKeyDeclaration}\n}\n`,
  );
}

describe("npx @nestjs/observe link", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-link-"));
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          name: "orders-api",
          // What `nest new` generates, plus a script that is not a start.
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
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const run = (h: ReturnType<typeof harness>, openBrowser = true) =>
    link({ cwd, endpoint: "https://api.test", openBrowser }, h.deps);

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

  describe("the nest new placeholders", () => {
    beforeEach(() => {
      mkdirSync(join(cwd, "src"));
      writeFileSync(join(cwd, "src", "app.module.ts"), SCAFFOLDED_APP_MODULE);
    });

    it("points AppModule at the environment once .env holds the pair", async () => {
      installSdk(cwd, "appKey?: string;");
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      expect(readFileSync(join(cwd, "src", "app.module.ts"), "utf8")).toBe(
        SCAFFOLDED_APP_MODULE.replace(
          "'YOUR_APP_KEY'",
          "process.env.OBSERVE_APP_KEY",
        ).replace("'YOUR_APP_SECRET'", "process.env.OBSERVE_APP_SECRET"),
      );
      expect(h.lines).toContain(
        "  src/app.module.ts now reads the pair from OBSERVE_APP_KEY and OBSERVE_APP_SECRET in place of the YOUR_APP_KEY placeholders.",
      );
    });

    it("keeps them where the installed SDK would not compile process.env", async () => {
      installSdk(cwd, "appKey: string;");
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      expect(readFileSync(join(cwd, "src", "app.module.ts"), "utf8")).toBe(
        SCAFFOLDED_APP_MODULE,
      );
      expect(h.lines).toContainEqual(
        expect.stringMatching(
          /^ {2}src\/app\.module\.ts still holds the YOUR_APP_KEY placeholders\. The SDK reads \.env in their place.*0\.3\.16 or later/,
        ),
      );
    });

    it("keeps them when nothing tells it the SDK is installed", async () => {
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);
      expect(readFileSync(join(cwd, "src", "app.module.ts"), "utf8")).toBe(
        SCAFFOLDED_APP_MODULE,
      );
    });

    it("finds them in every application of a monorepo", async () => {
      installSdk(cwd, "appKey?: string;");
      writeFileSync(
        join(cwd, "nest-cli.json"),
        JSON.stringify({
          sourceRoot: "apps/api/src",
          monorepo: true,
          projects: {
            api: { type: "application", sourceRoot: "apps/api/src" },
            worker: { type: "application", sourceRoot: "apps/worker/src" },
          },
        }),
      );
      for (const app of ["api", "worker"]) {
        mkdirSync(join(cwd, "apps", app, "src"), { recursive: true });
        writeFileSync(
          join(cwd, "apps", app, "src", "app.module.ts"),
          SCAFFOLDED_APP_MODULE,
        );
      }
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);

      for (const app of ["api", "worker"]) {
        expect(
          readFileSync(join(cwd, "apps", app, "src", "app.module.ts"), "utf8"),
        ).toContain("appKey: process.env.OBSERVE_APP_KEY,");
      }
      expect(h.lines).toContainEqual(
        expect.stringContaining(
          "apps/api/src/app.module.ts, apps/worker/src/app.module.ts and src/app.module.ts now read the pair",
        ),
      );
    });

    it("leaves a value the application passes itself alone", async () => {
      installSdk(cwd, "appKey?: string;");
      const own = SCAFFOLDED_APP_MODULE.replace(
        "appKey: 'YOUR_APP_KEY'",
        "appKey: config.get('OBSERVE_KEY')",
      ).replace("appSecret: 'YOUR_APP_SECRET'", "appSecret: vault.secret");
      writeFileSync(join(cwd, "src", "app.module.ts"), own);
      const h = harness([{ status: 200, body: LINKED }]);

      expect(await run(h)).toBe(0);
      expect(readFileSync(join(cwd, "src", "app.module.ts"), "utf8")).toBe(own);
    });

    it("leaves them alone when the link is denied", async () => {
      installSdk(cwd, "appKey?: string;");
      const h = harness([{ status: 400, body: { error: "access_denied" } }]);

      expect(await run(h)).toBe(1);
      expect(readFileSync(join(cwd, "src", "app.module.ts"), "utf8")).toBe(
        SCAFFOLDED_APP_MODULE,
      );
    });
  });
});
