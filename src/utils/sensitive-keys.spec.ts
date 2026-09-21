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
});
