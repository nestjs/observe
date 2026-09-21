import { LogRedactor } from "./log-redactor.js";

/**
 * Redaction runs in the emitting process, on the way into the shared buffer.
 * Anything it misses has already crossed the network and been persisted by the
 * time anyone could scrub it, so the cases below are about what actually leaves
 * the process - not about tidy output.
 */
describe("LogRedactor", () => {
  const redactor = new LogRedactor();

  describe("key=value in free text", () => {
    it.each([
      ["password=hunter2", "password"],
      ["passwd=hunter2", "passwd"],
      ["pwd=hunter2", "pwd"],
      ["secret=s3cr3t", "secret"],
      ["token=abc123def", "token"],
      ["access_token=abc123def", "access_token"],
      ["refresh-token=abc123def", "refresh-token"],
      ["api_key=abc123def", "api_key"],
      ["apiKey=abc123def", "apiKey"],
      ["private_key=abc123def", "private_key"],
      ["session_id=abc123def", "session_id"],
    ])("masks the value in %s", (line, key) => {
      const output = redactor.redactMessage(`user login ${line} ok`);

      expect(output).not.toContain("hunter2");
      expect(output).not.toContain("s3cr3t");
      expect(output).not.toContain("abc123def");
      // The key survives: a line reading `password=[REDACTED]` says what was
      // removed, where a vanished pair says nothing.
      expect(output).toContain(key);
      expect(output).toContain("[REDACTED]");
    });

    it("handles JSON-style quoting", () => {
      const output = redactor.redactMessage('{"password": "hunter2"}');

      expect(output).not.toContain("hunter2");
      expect(output).toContain("password");
    });

    it("is case-insensitive on the key", () => {
      expect(redactor.redactMessage("PASSWORD=hunter2")).not.toContain(
        "hunter2",
      );
      expect(redactor.redactMessage("ApiKey=hunter2")).not.toContain("hunter2");
    });

    it("masks every occurrence, not just the first", () => {
      const output = redactor.redactMessage(
        "password=first and password=second",
      );

      expect(output).not.toContain("first");
      expect(output).not.toContain("second");
    });
  });

  describe("authorization schemes", () => {
    it.each(["Bearer", "Basic", "Token"])(
      "keeps the scheme and masks the credential for a bare %s token",
      (scheme) => {
        const output = redactor.redactMessage(
          `sent ${scheme} dXNlcjpwYXNzd29yZA== upstream`,
        );

        expect(output).not.toContain("dXNlcjpwYXNzd29yZA");
        // With no key prefix the scheme survives, so the line still says what
        // kind of credential was removed.
        expect(output).toContain(scheme);
      },
    );

    it.each(["Bearer", "Basic", "Token"])(
      "collapses scheme and credential together under an Authorization key (%s)",
      (scheme) => {
        const output = redactor.redactMessage(
          `Authorization: ${scheme} dXNlcjpwYXNzd29yZA==`,
        );

        expect(output).not.toContain("dXNlcjpwYXNzd29yZA");
        // Deliberate: the key=value rule's value alternation matches the
        // scheme-prefixed form, so this yields one `[REDACTED]` rather than
        // `Bearer [REDACTED]` stacked behind a second replacement.
        expect(output).toBe("Authorization: [REDACTED]");
      },
    );

    it("does not leave the credential behind on an Authorization header", () => {
      // The key=value rule stops its value at whitespace, so on its own it would
      // consume the word "Basic" and leave the credential in the line. The
      // scheme rule has to run first.
      const output = redactor.redactMessage(
        "Authorization: Basic dXNlcjpwYXNzd29yZA==",
      );

      expect(output).not.toContain("dXNlcjpwYXNzd29yZA");
    });

    it("does not stack replacements on an already-masked header", () => {
      const output = redactor.redactMessage("Authorization: Bearer [REDACTED]");

      expect(output.match(/\[REDACTED\]/g)).toHaveLength(1);
    });

    it("leaves a short word after the scheme alone", () => {
      // Eight characters is the floor; "Bearer of bad news" is prose.
      expect(redactor.redactMessage("Bearer of bad news")).toBe(
        "Bearer of bad news",
      );
    });
  });

  describe("bare tokens", () => {
    it("masks a JWT outside any header", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

      const output = redactor.redactMessage(`token issued: ${jwt}`);

      expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
      expect(output).toContain("[REDACTED]");
    });

    it("masks an AWS access key id", () => {
      const output = redactor.redactMessage("using AKIAIOSFODNN7EXAMPLE now");

      expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("masks a PEM private key block spanning lines", () => {
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAx0Vv0Q==",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");

      const output = redactor.redactMessage(`key loaded:\n${pem}`);

      expect(output).not.toContain("MIIEowIBAAKCAQEAx0Vv0Q");
      expect(output).not.toContain("BEGIN RSA PRIVATE KEY");
    });
  });

  describe("card numbers", () => {
    it("masks a Luhn-valid card number", () => {
      const output = redactor.redactMessage("charged card 4242424242424242");

      expect(output).not.toContain("4242424242424242");
    });

    it("masks one written with spaces or dashes", () => {
      expect(redactor.redactMessage("4242 4242 4242 4242")).not.toContain(
        "4242 4242 4242 4242",
      );
      expect(redactor.redactMessage("4242-4242-4242-4242")).not.toContain(
        "4242-4242-4242-4242",
      );
    });

    it("leaves a long number that is not Luhn-valid alone", () => {
      // Order ids, concatenated timestamps and trace ids are all card-shaped.
      // A rule that masked them would shred ordinary numeric log data and get
      // switched off, and a switched-off redactor protects nothing.
      const output = redactor.redactMessage("order 1234567890123456 shipped");

      expect(output).toContain("1234567890123456");
    });
  });

  describe("ordinary content", () => {
    it.each([
      "GET /orders 200 in 12ms",
      "user signed in successfully",
      "retrying connection to 10.0.0.5:5432",
      "processed 1523 records in 4.2s",
    ])("leaves %s untouched", (line) => {
      expect(redactor.redactMessage(line)).toBe(line);
    });
  });

  describe("attributes", () => {
    it("masks a sensitive key whatever its value contains", () => {
      const output = redactor.redactAttributes({
        userId: "u-1",
        password: "hunter2",
      });

      expect(output).toEqual({ userId: "u-1", password: "[REDACTED]" });
    });

    it("masks a sensitive key holding an object rather than walking into it", () => {
      const output = redactor.redactAttributes({
        credentials: { username: "admin", password: "hunter2" },
      });

      // Walking in and preserving `username` is exactly the partial leak this
      // avoids.
      expect(output).toEqual({ credentials: "[REDACTED]" });
    });

    it("normalises key spelling", () => {
      const output = redactor.redactAttributes({
        "Api-Key": "abc",
        access_token: "def",
        SESSIONID: "ghi",
      });

      expect(Object.values(output!)).toEqual([
        "[REDACTED]",
        "[REDACTED]",
        "[REDACTED]",
      ]);
    });

    it("redacts secrets inside nested values", () => {
      const output = redactor.redactAttributes({
        request: { headers: { note: "Authorization: Bearer abcdefghijkl" } },
      });

      expect(JSON.stringify(output)).not.toContain("abcdefghijkl");
    });

    it("redacts inside arrays", () => {
      const output = redactor.redactAttributes({
        lines: ["password=hunter2", "harmless"],
      });

      expect(JSON.stringify(output)).not.toContain("hunter2");
      expect(JSON.stringify(output)).toContain("harmless");
    });

    it("stops descending past the depth limit", () => {
      // Attributes come from JSON.parse so they cannot be cyclic, but they can
      // be arbitrarily deep, and this runs on every log line.
      let deep: Record<string, unknown> = { value: "bottom" };
      for (let i = 0; i < 20; i++) {
        deep = { nested: deep };
      }

      const output = redactor.redactAttributes(deep);

      expect(JSON.stringify(output)).toContain("[REDACTED]");
      expect(JSON.stringify(output)).not.toContain("bottom");
    });

    it("passes undefined through", () => {
      expect(redactor.redactAttributes(undefined)).toBeUndefined();
    });

    it("leaves non-string leaves as their own type", () => {
      const output = redactor.redactAttributes({
        count: 5,
        ok: true,
        missing: null,
      });

      expect(output).toEqual({ count: 5, ok: true, missing: null });
    });
  });

  describe("compound attribute keys", () => {
    it("masks a credential named for what it is", () => {
      expect(
        redactor.redactAttributes({
          clientSecret: "s3cr3t",
          resetToken: "abc",
          maxTokens: 4096,
        }),
      ).toEqual({
        clientSecret: "[REDACTED]",
        resetToken: "[REDACTED]",
        maxTokens: 4096,
      });
    });
  });

  describe("source lines", () => {
    it("masks a literal assigned to a sensitive name", () => {
      expect(
        redactor.redactSource([
          "export default {",
          '  dbPassword: "hunter2",',
          "  apiKey: 'sk_live_abcdef',",
          "};",
        ]),
      ).toEqual([
        "export default {",
        "  dbPassword: [REDACTED],",
        "  apiKey: [REDACTED],",
        "};",
      ]);
    });

    it("leaves code that only names a credential as it was written", () => {
      const lines = [
        "const token = await this.auth.sign(user);",
        "if (password !== confirmation) {",
        "  return { secret: process.env.APP_SECRET };",
      ];

      expect(redactor.redactSource(lines)).toEqual(lines);
    });

    it("keeps the line count when a match spans lines", () => {
      const lines = [
        "const key = `-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "-----END PRIVATE KEY-----`;",
        "after();",
      ];

      const output = redactor.redactSource(lines);

      expect(output).toHaveLength(lines.length);
      expect(output.join("\n")).not.toContain("MIIEvQ");
      expect(output[3]).toBe("after();");
    });
  });

  describe("configuration", () => {
    it("uses a custom replacement string", () => {
      const custom = new LogRedactor({ replacement: "***" });

      expect(custom.redactMessage("password=hunter2")).toContain("***");
    });

    it("accepts extra sensitive keys", () => {
      const custom = new LogRedactor({ keys: ["nationalId"] });

      expect(
        custom.redactAttributes({ nationalId: "123", other: "keep" }),
      ).toEqual({ nationalId: "[REDACTED]", other: "keep" });
    });

    it("applies a caller-supplied pattern to every occurrence", () => {
      // A pattern supplied without /g would silently redact only the first hit.
      const custom = new LogRedactor({ patterns: [/CUST-\d+/] });

      const output = custom.redactMessage("CUST-1 and CUST-2");

      expect(output).not.toContain("CUST-1");
      expect(output).not.toContain("CUST-2");
    });

    it("can turn the defaults off entirely", () => {
      const custom = new LogRedactor({ useDefaultPatterns: false });

      expect(custom.redactMessage("password=hunter2")).toBe("password=hunter2");
      expect(custom.redactMessage("4242424242424242")).toBe("4242424242424242");
    });

    it("still masks sensitive attribute keys with the defaults off", () => {
      // Key masking is a separate mechanism from the text patterns.
      const custom = new LogRedactor({ useDefaultPatterns: false });

      expect(custom.redactAttributes({ password: "hunter2" })).toEqual({
        password: "[REDACTED]",
      });
    });
  });
});
