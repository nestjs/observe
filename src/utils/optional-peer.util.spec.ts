import { loadAsResolvedBy, loadOptionalPeer } from "./optional-peer.util.js";

describe("loadOptionalPeer", () => {
  it("reports a package that is not installed", () => {
    const result = loadOptionalPeer("@nestjs/definitely-not-a-real-package");

    expect(result).toEqual({ installed: false });
  });

  it("loads an installed package", () => {
    const result = loadOptionalPeer<typeof import("rxjs")>("rxjs");

    expect(result.installed).toBe(true);
    expect(result.installed && result.module?.Subscription).toEqual(
      expect.any(Function),
    );
  });

  it("loads a subpath an exports map hides", () => {
    // @nestjs/schedule ships an exports map that refuses this subpath, and
    // does not re-export the explorer from its entry point.
    const result = loadOptionalPeer<{ ScheduleExplorer?: unknown }>(
      "@nestjs/schedule",
      "@nestjs/schedule/dist/schedule.explorer.js",
    );

    expect(result.installed).toBe(true);
    expect(result.installed && result.module?.ScheduleExplorer).toEqual(
      expect.any(Function),
    );
  });

  it("keeps 'installed but unloadable' apart from 'not installed'", () => {
    const result = loadOptionalPeer(
      "rxjs",
      "rxjs/dist/no-such-file-anywhere.js",
    );

    expect(result.installed).toBe(true);
    expect(result.installed && result.module).toBeUndefined();
    expect(result.installed && result.error).toBeDefined();
  });
});

describe("loadAsResolvedBy", () => {
  it("loads a module the way another installed package resolves it", () => {
    const viaMongoose = loadAsResolvedBy<{ version: string }>(
      "mongoose",
      "mongodb/package.json",
    );

    // Whichever copy Mongoose runs on - here the hoisted one, in an
    // application with an older direct dependency a nested one.
    expect(viaMongoose?.version).toEqual(expect.any(String));
  });

  it("answers undefined for a package that is not installed, or a path it cannot resolve", () => {
    expect(loadAsResolvedBy("not-a-real-orm", "mongodb")).toBeUndefined();
    expect(loadAsResolvedBy("mongoose", "mongodb/nope.js")).toBeUndefined();
  });
});
