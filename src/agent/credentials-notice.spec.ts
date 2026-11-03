import { describe, expect, it } from "vitest";
import {
  DEMO_URL,
  describeMissingCredentials,
  LINK_COMMAND,
} from "./credentials-notice.js";

/**
 * The start-up line for an agent with no key pair it can send with.
 *
 * Pinned by situation rather than by sentence: what matters is which advice
 * each one gets - connect a fresh project with link, name the variables a
 * deployment is missing - and that production is never told to sign up.
 */
describe("describeMissingCredentials", () => {
  it("tells a fresh nest new project to link, and keeps the demo", () => {
    const notice = describeMissingCredentials({
      scaffold: true,
      production: false,
    });

    expect(notice.level).toBe("log");
    expect(notice.message).toContain("not connected yet");
    expect(notice.message).toContain(LINK_COMMAND);
    expect(notice.message).toContain(DEMO_URL);
    expect(notice.message).not.toContain("create a free account");
  });

  it.each([
    ["the nest new placeholders", { scaffold: true }],
    ["no key pair at all", { scaffold: false, unset: "both" as const }],
    [
      "a key without its secret",
      { scaffold: false, unset: "appSecret" as const },
    ],
  ])(
    "names the variables a production process with %s is missing",
    (_label, input) => {
      const notice = describeMissingCredentials({ ...input, production: true });

      expect(notice.level).toBe("warn");
      expect(notice.message).toContain("sends nothing");
      expect(notice.message).toContain(
        "Set OBSERVE_APP_KEY and OBSERVE_APP_SECRET in this environment",
      );
      // Someone with a linked project already has an account: pointing them
      // at sign-up sends them looking for a pair they already own.
      expect(notice.message).not.toMatch(/create (a free account|one at)/i);
      expect(notice.message).not.toContain(DEMO_URL);
    },
  );

  it("says which half is missing outside production", () => {
    expect(
      describeMissingCredentials({
        scaffold: false,
        unset: "appKey",
        production: false,
      }).message,
    ).toContain("appKey is not set");
    expect(
      describeMissingCredentials({
        scaffold: false,
        unset: "both",
        production: false,
      }),
    ).toMatchObject({
      level: "warn",
      message: expect.stringContaining("appKey and appSecret are not set"),
    });
  });

  it("offers link alongside the dashboard to a hand-wired project in development", () => {
    const { message } = describeMissingCredentials({
      scaffold: false,
      unset: "both",
      production: false,
    });

    expect(message).toContain(LINK_COMMAND);
    expect(message).toContain("https://observe.nestjs.com");
  });
});
