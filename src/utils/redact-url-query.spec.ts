import { LogRedactor } from "./log-redactor.js";
import { redactUrlQuery } from "./redact-url-query.js";

describe("redactUrlQuery", () => {
  it("leaves a URL with no query alone", () => {
    expect(redactUrlQuery("/me/projects")).toEqual("/me/projects");
  });

  it("leaves ordinary parameters exactly as they arrived", () => {
    // Byte-for-byte, not merely equivalent: a URL with nothing to hide must not
    // come back in URLSearchParams' normalised spelling.
    expect(redactUrlQuery("/telemetry?from=2026-01-01&limit=50")).toEqual(
      "/telemetry?from=2026-01-01&limit=50",
    );
  });

  it("masks the value and keeps the key", () => {
    expect(redactUrlQuery("/reset?token=abc123")).toEqual(
      "/reset?token=%5BREDACTED%5D",
    );
  });

  it("masks the parameters that carry credentials", () => {
    for (const key of [
      "password",
      "secret",
      "access_token",
      "accessToken",
      "api-key",
      "authorization",
      "code",
      "signature",
      "sessionid",
    ]) {
      expect(redactUrlQuery(`/x?${key}=sensitive`)).not.toContain("sensitive");
    }
  });

  it("keeps the harmless parameters beside a masked one", () => {
    const redacted = redactUrlQuery("/x?page=2&token=abc&sort=desc");

    expect(redacted).toContain("page=2");
    expect(redacted).toContain("sort=desc");
    expect(redacted).not.toContain("abc");
  });

  it("masks every occurrence of a repeated parameter", () => {
    expect(redactUrlQuery("/x?token=one&token=two")).not.toMatch(/one|two/);
  });

  it("preserves the path and the fragment", () => {
    const redacted = redactUrlQuery("/a/b/c?token=abc#section");

    expect(redacted.startsWith("/a/b/c?")).toBe(true);
    expect(redacted.endsWith("#section")).toBe(true);
  });

  it("does not mask a value that merely looks like a token", () => {
    // Keys only. Hunting for token-shaped values mangles real ids, and a
    // redactor that mangles real data gets switched off.
    expect(redactUrlQuery("/users?id=ghp_abcdefghijklmnop")).toEqual(
      "/users?id=ghp_abcdefghijklmnop",
    );
  });

  it("masks compound credential names, not just the bare word", () => {
    for (const key of [
      "resetToken",
      "inviteToken",
      "client_secret",
      "jwt",
      "key",
      "cookie",
      "X-Amz-Signature",
      "X-Amz-Security-Token",
    ]) {
      expect(redactUrlQuery(`/x?${key}=sensitive`)).not.toContain("sensitive");
    }
  });

  it("applies the keys the deployment configured", () => {
    const redactor = new LogRedactor({ keys: ["tenant_ref"] });

    expect(redactUrlQuery("/x?tenantRef=acme&page=2", redactor)).toEqual(
      "/x?tenantRef=%5BREDACTED%5D&page=2",
    );
    expect(redactUrlQuery("/x?tenantRef=acme")).toEqual("/x?tenantRef=acme");
  });
});
