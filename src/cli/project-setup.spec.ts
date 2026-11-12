import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findEntryFiles,
  loadTypeScript,
  serviceIdFor,
} from "./project-setup.js";

describe("serviceIdFor", () => {
  it("turns the application's name into an id the way the dashboard does", () => {
    expect(serviceIdFor("Orders API")).toBe("orders-api");
    expect(serviceIdFor("billing_worker 2")).toBe("billingworker-2");
  });

  it("falls back to the package's name, without its scope", () => {
    expect(serviceIdFor("___", "@acme/orders-api")).toBe("orders-api");
    expect(serviceIdFor(undefined, undefined)).toBe("app");
  });
});

describe("loadTypeScript", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-typescript-"));
    // The compiler the project installed, as far as the CLI needs one.
    mkdirSync(join(cwd, "node_modules", "typescript"), { recursive: true });
    writeFileSync(
      join(cwd, "node_modules", "typescript", "package.json"),
      JSON.stringify({ name: "typescript", main: "main.cjs" }),
    );
    writeFileSync(
      join(cwd, "node_modules", "typescript", "main.cjs"),
      "exports.createSourceFile = () => undefined; exports.marker = 'installed';",
    );
    // A project file `require("typescript")` reaches first when the project
    // is itself named `typescript`: package self-reference.
    writeFileSync(
      join(cwd, "own.cjs"),
      "globalThis.__observeOwnFileRan = true; exports.marker = 'own';",
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    delete (globalThis as { __observeOwnFileRan?: boolean })
      .__observeOwnFileRan;
  });

  it.each([["./own.cjs"], [{ ".": { require: "./own.cjs" } }]])(
    "loads the installed compiler, not the project's own exports %j, in a project named typescript",
    (exports) => {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ name: "typescript", exports }),
      );

      const loaded = loadTypeScript(cwd) as unknown as { marker?: string };

      expect(loaded?.marker).toBe("installed");
      expect(
        (globalThis as { __observeOwnFileRan?: boolean }).__observeOwnFileRan,
      ).toBeUndefined();
    },
  );

  it("loads the installed compiler of an ordinary project, and none where there is none", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "app" }));
    expect(
      (loadTypeScript(cwd) as unknown as { marker?: string })?.marker,
    ).toBe("installed");

    const bare = mkdtempSync(join(tmpdir(), "observe-typescript-"));
    try {
      writeFileSync(join(bare, "package.json"), JSON.stringify({ name: "a" }));
      expect(loadTypeScript(bare)).toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("findEntryFiles", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "observe-entry-"));
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  const touch = (path: string, text = "") => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };

  it("finds src/main.ts without a nest-cli.json", () => {
    touch("src/main.ts");
    expect(findEntryFiles(cwd, ts)).toEqual(["src/main.ts"]);
  });

  it("reads a nest-cli.json with comments, and skips libraries", () => {
    touch(
      "nest-cli.json",
      `{
        // The default project.
        "sourceRoot": "apps/orders/src",
        "projects": {
          "orders": { "type": "application", "root": "apps/orders" },
          "shared": { "type": "library", "root": "libs/shared" },
        },
      }`,
    );
    touch("apps/orders/src/main.ts");
    touch("libs/shared/src/main.ts");

    expect(findEntryFiles(cwd, ts)).toEqual(["apps/orders/src/main.ts"]);
  });
});
