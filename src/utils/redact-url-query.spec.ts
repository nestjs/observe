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

  it("masks in place, keeping the spelling of what it does not mask", () => {
    // `queryParamsObfuscateRegex` runs on this result, so a parameter must
    // keep the spelling the request carried whether or not one beside it is
    // masked - URLSearchParams would turn `%20` into `+` and `%40` into `@`'s
    // other spelling.
    expect(redactUrlQuery("/x?q=a%20b&email=a%40b.c&token=abc")).toEqual(
      "/x?q=a%20b&email=a%40b.c&token=%5BREDACTED%5D",
    );
  });

  it("keeps both pairs of a repeated sensitive key", () => {
    expect(redactUrlQuery("/x?token=one&page=2&token=two")).toEqual(
      "/x?token=%5BREDACTED%5D&page=2&token=%5BREDACTED%5D",
    );
  });

  it("reads a percent-encoded key the way the server does", () => {
    expect(redactUrlQuery("/x?%74oken=abc&api%5Fkey=def")).toEqual(
      "/x?%74oken=%5BREDACTED%5D&api%5Fkey=%5BREDACTED%5D",
    );
  });

  it("masks a credential in a URL carried as another parameter's value", () => {
    const redacted = redactUrlQuery(
      "/login?returnTo=%2Finvitations%2Faccept%3Ftoken%3Ds3cr3t%26step%3D2",
    );

    expect(redacted).not.toContain("s3cr3t");
    expect(decodeURIComponent(redacted.split("returnTo=")[1])).toEqual(
      "/invitations/accept?token=%5BREDACTED%5D&step=2",
    );
  });

  it("leaves a nested URL with nothing to hide as it arrived", () => {
    for (const url of [
      "/x?next=%2Fusers%3Fpage%3D2%26sort%3Ddesc",
      "/x?q=a=b&cursor=YWJj==",
      "/x?next=/users?page=2",
    ]) {
      expect(redactUrlQuery(url)).toEqual(url);
    }
  });

  it("masks a nested URL whole past the nesting limit", () => {
    let url = "/x?token=deep";
    for (let level = 0; level < 8; level++) {
      url = `/x?next=${encodeURIComponent(url)}`;
    }

    expect(redactUrlQuery(url)).not.toContain("deep");
  });

  it("masks a credential inside a JSON value", () => {
    const input = encodeURIComponent(
      JSON.stringify({ filter: { status: "open" }, token: "s3cr3t" }),
    );

    const redacted = redactUrlQuery(`/trpc/list?input=${input}&batch=1`);

    expect(redacted).not.toContain("s3cr3t");
    expect(redacted).toContain("batch=1");
    expect(JSON.parse(decodeURIComponent(redacted.split(/[=&]/)[1]))).toEqual({
      filter: { status: "open" },
      token: "[REDACTED]",
    });
  });

  it("masks path parameters behind a semicolon", () => {
    // Fastify's `useSemicolonDelimiter`, and servlet containers, read these.
    expect(redactUrlQuery("/account;jsessionid=abc123")).toEqual(
      "/account;jsessionid=%5BREDACTED%5D",
    );
    expect(redactUrlQuery("/page.do;v=1;jsessionid=abc123?x=1")).toEqual(
      "/page.do;v=1;jsessionid=%5BREDACTED%5D?x=1",
    );
    expect(redactUrlQuery("/map;lat=50.1;lng=8.6")).toEqual(
      "/map;lat=50.1;lng=8.6",
    );
  });

  it("masks parameters behind a fragment", () => {
    // A raw `path` handed to node:http is sent with its `#` and all, and an
    // OAuth implicit-flow callback carries its token there.
    expect(redactUrlQuery("/geocode?q=x#&api_key=abc123")).toEqual(
      "/geocode?q=x#&api_key=%5BREDACTED%5D",
    );
    expect(redactUrlQuery("/callback#access_token=abc123&page=2")).toEqual(
      "/callback#access_token=%5BREDACTED%5D&page=2",
    );
    expect(redactUrlQuery("/docs#api-key")).toEqual("/docs#api-key");
    expect(redactUrlQuery("/docs?page=2#section-3")).toEqual(
      "/docs?page=2#section-3",
    );
  });

  it("leaves a parameter with no value alone", () => {
    expect(redactUrlQuery("/x?token&page=2")).toEqual("/x?token&page=2");
  });

  it("does not throw on a malformed escape", () => {
    expect(redactUrlQuery("/x?%E0%A4%A=1&token=abc")).toEqual(
      "/x?%E0%A4%A=1&token=%5BREDACTED%5D",
    );
  });

  it("applies the deployment's pattern on top of the key rules", () => {
    expect(
      redactUrlQuery("/x?tenant=acme&token=abc", null, /tenant=[^&]*/g),
    ).toEqual("/x?[REDACTED]&token=%5BREDACTED%5D");
  });
});
