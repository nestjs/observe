import { createSensitiveKeyMatcher } from "./sensitive-keys.js";

describe("createSensitiveKeyMatcher", () => {
  const isSensitive = createSensitiveKeyMatcher();

  it("matches a credential by what its name ends in", () => {
    for (const key of [
      "token",
      "resetToken",
      "reset_token",
      "resettoken",
      "client_secret",
      "clientSecret",
      "jwt",
      "X-Amz-Signature",
      "X-Amz-Security-Token",
      "x-api-key",
      "cookie",
      "set-cookie",
      "awsSecretAccessKey",
      "Proxy-Authorization",
    ]) {
      expect(isSensitive(key), key).toBe(true);
    }
  });

  it("matches the names that put the noun first", () => {
    for (const key of ["passwordConfirmation", "secret_value", "password2"]) {
      expect(isSensitive(key), key).toBe(true);
    }
  });

  it("matches a short credential word at the end of a compound name", () => {
    for (const key of [
      "token_auth",
      "report_pwd",
      "db_pwd",
      "pwd2",
      "x-auth",
    ]) {
      expect(isSensitive(key), key).toBe(true);
    }
  });

  it("matches names written with dots, brackets or spaces", () => {
    for (const key of [
      "api.key",
      "session.id",
      "auth[token]",
      "user[password]",
      "token[]",
      "Api Key",
    ]) {
      expect(isSensitive(key), key).toBe(true);
    }
  });

  it("matches the noun inside acronyms and run-together names", () => {
    for (const key of [
      "SMTPPasswordNew",
      "passwordconfirm",
      "PASSWORDHASH",
      "APISecretValue",
    ]) {
      expect(isSensitive(key), key).toBe(true);
    }
  });

  it("leaves the keys that only mention a credential alone", () => {
    for (const key of [
      "maxTokens",
      "tokenCount",
      "token_limit",
      "secretary",
      "author",
      "sortKey",
      "cacheKey",
      "code",
      "state",
      "id",
      "oauth",
      "authors",
      "keyboard",
      "data[tokenCount]",
    ]) {
      expect(isSensitive(key), key).toBe(false);
    }
  });

  it("matches configured keys exactly, whatever their spelling", () => {
    const configured = createSensitiveKeyMatcher(["tenant_ref"]);

    expect(configured("tenantRef")).toBe(true);
    expect(configured("TENANT-REF")).toBe(true);
    expect(configured("tenantRefs")).toBe(false);
  });

  it("strips a numbered suffix in linear time", () => {
    // Query-string keys come from the client, and `\d+$` restarted at every
    // digit of a run that is not at the end: ~350 ms for this key.
    const key = "1".repeat(15_000) + "x";
    const startedAt = performance.now();

    expect(isSensitive(key)).toBe(false);
    expect(isSensitive("1".repeat(15_000) + "token")).toBe(true);

    expect(performance.now() - startedAt).toBeLessThan(25);
  });
});
