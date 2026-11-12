import {
  captureRequest,
  shouldCaptureRequest,
} from "./capture-request.util.js";
import { LogRedactor } from "./log-redactor.js";

describe("captureRequest", () => {
  const redactor = new LogRedactor();
  const req = {
    headers: {
      "user-agent": "curl/8.0",
      "content-type": "application/json",
      authorization: "Bearer abc.def.ghi",
      cookie: "session=1",
      "x-tenant-id": "acme",
      referer: "https://app.example.com/reset?token=s3cret&tab=2",
    },
    body: { email: "a@example.com", password: "hunter2", note: "hello" },
  };

  it("records only the default allow-list of headers, and no body", () => {
    const captured = captureRequest(req, undefined, redactor);

    expect(captured?.headers).toEqual({
      "user-agent": "curl/8.0",
      "content-type": "application/json",
      referer: expect.stringContaining("tab=2"),
    });
    expect(captured?.headers?.referer).not.toContain("s3cret");
    expect(captured?.body).toBeUndefined();
  });

  it("records nothing when switched off", () => {
    expect(captureRequest(req, false, redactor)).toBeUndefined();
    expect(captureRequest(req, { headers: false }, redactor)).toBeUndefined();
  });

  it("redacts a sensitive header even when the application names it", () => {
    const captured = captureRequest(
      req,
      { headers: ["Authorization", "X-Tenant-Id"] },
      redactor,
    );

    expect(captured?.headers).toEqual({
      authorization: "[REDACTED]",
      "x-tenant-id": "acme",
    });
  });

  it("masks the query of a URL in any captured header, not only referer", () => {
    const captured = captureRequest(
      {
        headers: {
          "x-forwarded-uri": "/oauth/callback?code=abc123&state=xyz",
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          accept: "text/html;q=0.9,*/*;q=0.8",
        },
      },
      { headers: ["x-forwarded-uri", "user-agent", "accept"] },
      redactor,
    );

    expect(captured?.headers).toEqual({
      "x-forwarded-uri":
        "/oauth/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      accept: "text/html;q=0.9,*/*;q=0.8",
    });
  });

  it("redacts a header before cutting it, so a secret across the cut is masked", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9." +
      "eyJzdWIiOiJ1c2VyLTQyIiwiZW1haWwiOiJhQGV4YW1wbGUuY29tIn0." +
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    // The cut at 512 falls inside the JWT's payload, before its last dot.
    const referer = `https://app.example.com/${"a".repeat(440)}/${jwt}`;

    const captured = captureRequest(
      { headers: { referer } },
      undefined,
      redactor,
    );

    expect(captured?.headers?.referer).not.toContain("eyJzdWIi");
    expect(captured?.headers?.referer.length).toBeLessThanOrEqual(512);
  });

  it("applies the deployment's query obfuscation pattern to captured URLs", () => {
    const captured = captureRequest(
      { headers: { referer: "https://app.example.com/x?tenant=acme&page=2" } },
      undefined,
      redactor,
      /tenant=[^&]*/g,
    );

    expect(captured?.headers?.referer).toEqual(
      "https://app.example.com/x?[REDACTED]&page=2",
    );
  });

  it("redacts a JSON body that arrived as a string by key, as a parsed one", () => {
    const captured = captureRequest(
      {
        body: JSON.stringify({
          tenantRef: "acme",
          profile: { passwordConfirmation: "Tr0ub4dor", signature: "sig-9f3c" },
          note: "hello",
        }),
      },
      { headers: false, body: true },
      new LogRedactor({ keys: ["tenant_ref"] }),
    );

    expect(JSON.parse(captured?.body ?? "")).toEqual({
      tenantRef: "[REDACTED]",
      profile: { passwordConfirmation: "[REDACTED]", signature: "[REDACTED]" },
      note: "hello",
    });
  });

  it("serializes no more of a sparse array than the cap can hold", () => {
    // multer turns `f[1000000]=x` into an array with a million holes, and each
    // hole serializes as `null`.
    const sparse: unknown[] = [];
    sparse[5_000_000] = "x";
    const nested: unknown[] = [];
    nested[2_000] = [];
    (nested[2_000] as unknown[])[2_000] = [];
    const startedAt = performance.now();

    const captured = captureRequest(
      { body: { f: sparse, g: nested, password: "hunter2" } },
      { headers: false, body: true },
      redactor,
    );

    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(captured?.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(captured?.body ?? "")).toBeLessThanOrEqual(2048);
    expect(captured?.body).not.toContain("hunter2");
  });

  it("records a body only on request, redacted by key before serialization", () => {
    const captured = captureRequest(req, { body: true }, redactor);
    const body = JSON.parse(captured!.body!);

    expect(body).toEqual({
      email: "a@example.com",
      password: "[REDACTED]",
      note: "hello",
    });
    expect(captured?.bodyTruncated).toBeUndefined();
  });

  it("cuts an oversized body and says so", () => {
    const captured = captureRequest(
      { headers: {}, body: { blob: "x".repeat(10_000) } },
      { headers: false, body: { maxBytes: 100 } },
      redactor,
    );

    expect(Buffer.byteLength(captured!.body!)).toBeLessThanOrEqual(100);
    expect(captured?.bodyTruncated).toBe(true);
  });

  it("keeps a cut through a multi-byte character under the cap, and leaves no replacement character", () => {
    // Every cap from 100 to 103 lands somewhere else inside a 2-, 3- or
    // 4-byte character.
    for (const glyph of ["ż", "€", "😀"]) {
      for (const maxBytes of [100, 101, 102, 103]) {
        const captured = captureRequest(
          { headers: {}, body: glyph.repeat(200) },
          { headers: false, body: { maxBytes } },
          redactor,
        );

        expect(Buffer.byteLength(captured!.body!)).toBeLessThanOrEqual(
          maxBytes,
        );
        expect(captured!.body).not.toContain("�");
        expect(captured?.bodyTruncated).toBe(true);
      }
    }
  });

  it("never lets maxBytes exceed the hard ceiling", () => {
    const captured = captureRequest(
      { headers: {}, body: { blob: "x".repeat(100_000) } },
      { headers: false, body: { maxBytes: 10_000_000 } },
      redactor,
    );

    expect(Buffer.byteLength(captured!.body!)).toBeLessThanOrEqual(16 * 1024);
  });

  it("skips bodies with nothing readable in them", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const body of [Buffer.from("raw"), circular, 42]) {
      expect(
        captureRequest(
          { headers: {}, body },
          { headers: false, body: true },
          null,
        ),
      ).toBeUndefined();
    }
  });
});

describe("shouldCaptureRequest", () => {
  it("picks failed requests, and nothing else by default", () => {
    expect(shouldCaptureRequest({ error: { message: "x" } }, undefined)).toBe(
      true,
    );
    expect(shouldCaptureRequest({ duration: 60_000 }, undefined)).toBe(false);
  });

  it("picks slow requests once a threshold is set", () => {
    const options = { slowerThanMs: 2000 };

    expect(shouldCaptureRequest({ duration: 2000 }, options)).toBe(true);
    expect(shouldCaptureRequest({ duration: 1999 }, options)).toBe(false);
    expect(shouldCaptureRequest({}, options)).toBe(false);
  });

  it("picks nothing when capture is off", () => {
    expect(shouldCaptureRequest({ error: { message: "x" } }, false)).toBe(
      false,
    );
  });
});
