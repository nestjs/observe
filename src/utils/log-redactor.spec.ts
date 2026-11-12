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

  describe("key=value edge cases", () => {
    it("reads a quoted value past the quotes it escapes", () => {
      const output = redactor.redactMessage(
        String.raw`Login refused: {"user":"bob","password":"Tr0\"ub4dor-correct-horse"}`,
      );

      expect(output).not.toMatch(/Tr0|horse/);
      expect(output).toContain('"user":"bob"');
    });

    it("masks pairs in JSON that is itself inside a string", () => {
      const output = redactor.redactMessage(
        String.raw`POST failed: {"body":"{\"password\":\"hunter2\",\"api_key\":\"k3y-9f3c\",\"user\":\"bob\"}"}`,
      );

      expect(output).not.toMatch(/hunter2|k3y-9f3c/);
      expect(output).toContain(String.raw`\"user\":\"bob\"`);
    });

    it("masks a quoted value cut off before its closing quote", () => {
      expect(redactor.redactMessage('{"user":"bob","password":"hunter')).toBe(
        '{"user":"bob","password":[REDACTED]',
      );
      expect(
        redactor.redactMessage('password="hunter2" user="bob attempt=3'),
      ).toBe('password=[REDACTED] user="bob attempt=3');
    });

    it("masks every cookie of a Cookie header", () => {
      expect(
        redactor.redactMessage(
          "Cookie: theme=dark; connect.sid=s%3AQb2x.k9f3c1a7e; lang=en",
        ),
      ).toBe("Cookie: [REDACTED]");
    });

    it("masks an Authorization header whatever its scheme", () => {
      for (const header of [
        "Authorization: ApiKey sk_live_9f3c1a7e2b4d",
        "authorization: Negotiate YIIGhgYJKoZIhvcSAQICAQBu",
        "Proxy-Authorization: Digest username=bob, response=6629fae4",
        "authorization: 4000 0566 5566 5556",
      ]) {
        expect(redactor.redactMessage(header), header).toBe(
          `${header.split(":")[0]}: [REDACTED]`,
        );
      }
    });

    it("masks a card number in full behind a sensitive key", () => {
      expect(
        redactor.redactMessage("token: 4000 0566 5566 5556 retry"),
      ).not.toMatch(/0566|5556/);
    });

    it("masks a structure under a sensitive key, and nothing after it", () => {
      expect(
        redactor.redactMessage(
          'failed with {"auth":{"user":"alice","pass":"abc123def"},"retries":25} after 3 tries',
        ),
      ).toBe('failed with {"auth":[REDACTED],"retries":25} after 3 tries');
      expect(redactor.redactMessage("credentials=[abc, def] refused")).toBe(
        "credentials=[REDACTED] refused",
      );
      expect(
        redactor.redactMessage('token: expired {"attempt":3} for u-1'),
      ).toBe('token: [REDACTED] {"attempt":3} for u-1');
    });

    it("does not take the next key for the value of an empty one", () => {
      for (const message of [
        "currentPassword:\nnewPassword: correct-horse-battery-staple",
        "currentPassword: newPassword: correct-horse-battery-staple",
        "Invalid Basic credentials: dXNlcjpwYXNzd29yZA",
      ]) {
        const output = redactor.redactMessage(message);
        expect(output, message).not.toMatch(/correct-horse|dXNlcjpw/);
        expect(output, message).not.toMatch(/\[REDACTED\]:/);
      }
    });

    it("masks pairs as util.inspect prints a Map or URLSearchParams", () => {
      expect(
        redactor.redactMessage("Map(1) { 'password' => '7822abcd' }"),
      ).toBe("Map(1) { 'password' => [REDACTED] }");
      expect(
        redactor.redactMessage("URLSearchParams { 'token' => 'abc123def' }"),
      ).toBe("URLSearchParams { 'token' => [REDACTED] }");
    });

    it("holds free text to the same key list as attributes", () => {
      for (const pair of [
        "passwordConfirmation=hunter2",
        "password2=hunter2",
        "secret_value=hunter2",
        "X-Amz-Signature=hunter2",
        "client_jwt=hunter2",
      ]) {
        expect(redactor.redactMessage(`sent ${pair} ok`), pair).toBe(
          `sent ${pair.split("=")[0]}=[REDACTED] ok`,
        );
      }
      expect(
        new LogRedactor({ keys: ["tenant_ref"] }).redactMessage(
          "tenant_ref=acme",
        ),
      ).toBe("tenant_ref=[REDACTED]");
    });

    it("still leaves keys that only mention a credential alone", () => {
      for (const message of [
        "maxTokens=4096 tokenCount=12",
        "secretary: Alice",
        "author=bob sortKey=name",
        "http://example.com:8080/path",
      ]) {
        expect(redactor.redactMessage(message)).toBe(message);
      }
    });

    it("masks a value behind colour codes", () => {
      expect(
        redactor.redactMessage(
          "{ password: \x1b[32m'hunter2-9f3c'\x1b[39m, card: \x1b[33m4111111111111111\x1b[39m }",
        ),
      ).toBe("{ password: [REDACTED], card: [REDACTED] }");
    });

    it.each([
      ["unclosed brackets", "password=[".repeat(30_000)],
      ["unclosed quotes", 'password="'.repeat(30_000)],
      ["escaped quotes", String.raw`\"password\":\"`.repeat(20_000)],
      ["empty values", "password: ".repeat(30_000)],
      ["keys only", "password".repeat(30_000)],
      ["nested opening", "token={".repeat(30_000)],
    ])("scans %s in linear time", (_name, text) => {
      const startedAt = performance.now();

      redactor.redactMessage(text);
      redactor.redactSource(text.split("\n"));

      // Generous, for a loaded machine: a scan that rescanned the rest of the
      // text per key would take tens of seconds on these.
      expect(performance.now() - startedAt).toBeLessThan(1000);
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

    it("scans a run of JWT-like fragments in linear time", () => {
      // Every line the forwarder ships is redacted synchronously inside
      // `process.stdout.write`. Quadratic under the JWT pattern this replaced:
      // ~2s for this input.
      const line = "eyJ-".repeat(16_384);
      const startedAt = performance.now();

      redactor.redactMessage(line);

      expect(performance.now() - startedAt).toBeLessThan(250);
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

    it("masks each PEM block and keeps what is between them", () => {
      const output = redactor.redactMessage(
        "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY----- then " +
          "-----BEGIN EC PRIVATE KEY-----\nBBBB\n-----END EC PRIVATE KEY-----",
      );

      expect(output).toBe("[REDACTED] then [REDACTED]");
    });

    it("masks a PEM block whose newlines are JSON-escaped", () => {
      const output = redactor.redactMessage(
        '{"key":"-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----"}',
      );

      expect(output).toBe('{"key":"[REDACTED]"}');
    });

    it("masks a PEM key cut off before its END line", () => {
      const output = redactor.redactMessage(
        "bad key: -----BEGIN RSA PRIVATE KEY-----\n" +
          "MIIEowIBAAKCAQEAx0Vv0QZx3mFq9nT2yQ8wJr5LcK1vYb7uPzE4sD6hGf2aWnXe\n" +
          "kL9pR3tU8vY1oZ6qS",
      );

      expect(output).toBe("bad key: [REDACTED]");
    });

    it("leaves a PEM BEGIN marker that heads no key as it was", () => {
      for (const message of [
        "expected -----BEGIN PRIVATE KEY----- at the start\nof the file",
        "-----BEGIN PRIVATE KEY-----\nexpected a key here",
        'if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) {',
      ]) {
        expect(redactor.redactMessage(message)).toBe(message);
      }
      expect(
        redactor.redactMessage(
          "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" +
            "expected -----BEGIN PRIVATE KEY----- at the start",
        ),
      ).toBe("[REDACTED]\nexpected -----BEGIN PRIVATE KEY----- at the start");
    });

    it("scans a run of unclosed PEM markers in linear time", () => {
      // An error's message and stack are redacted synchronously, at full
      // length, before the response is written. Quadratic under the PEM
      // pattern this replaced: ~6 s for this input.
      const markers = "-----BEGIN PRIVATE KEY-----".repeat(20_000);
      const dashes = markers + "-".repeat(500_000);
      const startedAt = performance.now();

      expect(redactor.redactMessage(markers)).toBe(markers);
      expect(redactor.redactMessage(dashes)).toBe(dashes);
      expect(redactor.redactSource(markers.split("-----B"))).toHaveLength(
        20_001,
      );

      // Generous, for a loaded machine: the quadratic rule took ~17 s here.
      expect(performance.now() - startedAt).toBeLessThan(1000);
    });

    it("masks a JWT right after a percent escape or a JSON escape", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

      for (const message of [
        `next=%2Fverify-email%2F${jwt}`,
        `{"msg":"issued:\\n${jwt}"}`,
        `{"msg":"\\u0022${jwt}"}`,
      ]) {
        expect(redactor.redactMessage(message), message).not.toContain(
          "eyJzdWIi",
        );
      }
      // Still not inside a word that merely contains the letters.
      expect(redactor.redactMessage(`abc${jwt}`)).toBe(`abc${jwt}`);
    });

    it("masks an encrypted JWT whole", () => {
      for (const jwe of [
        // `alg: dir` - no encrypted key, so the second part is empty.
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..bEz8xQp1aWkT2xYc.aGVsbG8gd29ybGQgc2VjcmV0.Wn4bQ9mTq2Xy3Ac1rP0vLw",
        "eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.Zm9vYmFyYmF6cXV4.bEz8xQp1aWkT2xYc.aGVsbG8gd29ybGQgc2VjcmV0.Wn4bQ9mTq2Xy3Ac1rP0vLw",
      ]) {
        expect(redactor.redactMessage(`sent ${jwe} upstream`)).toBe(
          "sent [REDACTED] upstream",
        );
      }
    });

    it("does not exhaust the regex stack on a multi-megabyte token", () => {
      // Each of these overflowed V8's backtrack stack from ~5.6 MB under a
      // counted quantifier, so the error being recorded was replaced by a
      // RangeError.
      const run = "a".repeat(6_000_000);
      for (const message of [
        `Bearer ${run}`,
        `eyJ${run}.abcd.efgh`,
        `-----BEGIN PRIVATE KEY-----\n${run}`,
        `password=${run}`,
      ]) {
        expect(() => redactor.redactMessage(message)).not.toThrow();
        expect(redactor.redactMessage(message)).not.toContain("aaaaaaaa");
      }
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

    it("masks one right after a JSON-escaped newline", () => {
      for (const message of [
        '{"msg":"card:\\n4111111111111111"}',
        '{"msg":"card:\\n4242 4242 4242 4242"}',
      ]) {
        expect(redactor.redactMessage(message), message).toBe(
          '{"msg":"card:\\n[REDACTED]"}',
        );
      }
    });

    it("masks one followed by an expiry date or a CVV", () => {
      for (const message of [
        "card 4111111111111111 12/27",
        "card 4111111111111111 123",
        "on 2026-11-05 4111 1111 1111 1111 charged",
      ]) {
        expect(redactor.redactMessage(message), message).not.toMatch(
          /4111|1111 1111/,
        );
      }
      expect(redactor.redactMessage("on 2026-11-05 4111 1111 1111 1111")).toBe(
        "on 2026-11-05 [REDACTED]",
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

    it("matches a key written with colour codes", () => {
      expect(
        redactor.redactAttributes({ "\x1b[32mpassword\x1b[39m": "hunter2" }),
      ).toEqual({ password: "[REDACTED]" });
    });

    it("masks a card number given as a number", () => {
      expect(
        redactor.redactAttributes({ number: 4111111111111111, amount: 1250 }),
      ).toEqual({ number: "[REDACTED]", amount: 1250 });
    });

    it("redacts a secret that ended up in a key", () => {
      // A JSON body parsed as a form: the whole document is one key.
      const output = redactor.redactAttributes({
        '{"username":"a","password":"hunter2"}': "",
      });

      expect(JSON.stringify(output)).not.toContain("hunter2");
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

    it("keeps the lines after a PEM BEGIN marker that is never closed", () => {
      const lines = [
        'if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) {',
        '  throw new Error("not a private key");',
        "}",
      ];

      expect(redactor.redactSource(lines)).toEqual(lines);
    });

    it("masks a key cut off by the end of the frame, keeping the line count", () => {
      const lines = [
        "const key = `-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
        "VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu",
      ];

      const output = redactor.redactSource(lines);

      expect(output).toHaveLength(3);
      expect(output.join("\n")).not.toMatch(/MIIEvQ|VJTUt9/);
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
