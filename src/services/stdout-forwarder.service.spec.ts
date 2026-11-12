import { ConsoleLogger, Logger } from "@nestjs/common";
import { AsyncLocalStorage } from "async_hooks";
import { ObserveAgentSharedBuffer } from "../agent/observe-agent.shared-buffer.js";
import { ObserveModuleOptionsWithDefaults } from "../interfaces/index.js";
import { CALLER_METADATA_KEY } from "../observe.constants.js";
import { StdoutForwarderService } from "./stdout-forwarder.service.js";

interface CapturedEntry {
  text: string;
  traceId?: string;
  spanId?: string;
  level?: string;
  context?: string;
  attributes?: Record<string, unknown>;
}

/**
 * Collects entries instead of buffering them for the agent thread.
 *
 * Substituted for the shared buffer so a test can read exactly what the
 * forwarder decided to ship - which is the whole subject here, since everything
 * this service does happens on the way into that buffer.
 */
class CapturingBuffer {
  readonly entries: CapturedEntry[] = [];

  pushLogs(logs: CapturedEntry[]) {
    this.entries.push(...logs);
  }
}

const TRACE_ID_KEY = "traceId";

describe("StdoutForwarderService", () => {
  let buffer: CapturingBuffer;
  let als: AsyncLocalStorage<Map<string, any>>;

  const build = (options: Partial<ObserveModuleOptionsWithDefaults> = {}) => {
    buffer = new CapturingBuffer();
    als = new AsyncLocalStorage();
    return new StdoutForwarderService(
      {
        traceIdKey: TRACE_ID_KEY,
        // Left off so the constructor does not patch process.stdout for the
        // whole run: tests that want the patch call `start()` and restore it.
        forwardLogs: false,
        ...options,
      } as ObserveModuleOptionsWithDefaults,
      buffer as unknown as ObserveAgentSharedBuffer,
      als,
    );
  };

  /** Feeds a chunk through the same path a stdout write takes. */
  const write = (
    service: StdoutForwarderService,
    chunk: string,
    stream: "stdout" | "stderr" = "stdout",
  ) =>
    (
      service as unknown as {
        consume(chunk: string, stream: "stdout" | "stderr"): void;
      }
    ).consume(chunk, stream);

  describe("chunk reassembly", () => {
    it("forwards a complete line", () => {
      const service = build();

      write(service, "hello world\n");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "hello world",
      ]);
    });

    it("forwards several lines from one chunk", () => {
      const service = build();

      write(service, "first\nsecond\nthird\n");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("holds a line split across two writes until its newline arrives", () => {
      const service = build();

      write(service, "split ");
      // stdout arrives in chunks, not lines - parsing the chunk directly would
      // mangle every log that straddles a boundary.
      expect(buffer.entries).toHaveLength(0);

      write(service, "across writes\n");
      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "split across writes",
      ]);
    });

    it("emits the complete lines in a chunk and holds the trailing fragment", () => {
      const service = build();

      write(service, "done\npartial");

      expect(buffer.entries.map((entry) => entry.text)).toEqual(["done"]);

      write(service, " finished\n");
      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "done",
        "partial finished",
      ]);
    });

    it("ignores blank lines", () => {
      const service = build();

      write(service, "\n\n   \n\n");

      expect(buffer.entries).toHaveLength(0);
    });

    it("forwards at most a bounded number of entries from one write", () => {
      const service = build();

      // One logged value full of line breaks - a client's username, say -
      // is one write. Every line of it used to become an entry, and the log
      // buffer's caps are shared by the whole process: one request could
      // push every other request's lines out of the batch.
      write(
        service,
        Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n",
      );

      expect(buffer.entries).toHaveLength(50);
      expect(buffer.entries[0].text).toBe("line 0");
      expect(buffer.entries[48].text).toBe("line 48");
      expect(buffer.entries[49].text).toContain("2951 more lines");
    });

    it("files the note on lines left out under the trace that wrote them", () => {
      const service = build();

      als.run(new Map([[TRACE_ID_KEY, "trace-flood"]]), () =>
        write(service, "x\n".repeat(100)),
      );

      expect(buffer.entries).toHaveLength(50);
      expect(
        buffer.entries.every((entry) => entry.traceId === "trace-flood"),
      ).toBe(true);
    });

    it("forwards an over-long fragment rather than growing without bound", () => {
      const service = build();

      // A progress bar or a streamed response writes indefinitely without a
      // newline; a partial line is still evidence, so it is shipped at the cap
      // rather than discarded.
      write(service, "x".repeat(9 * 1024));

      expect(buffer.entries).toHaveLength(1);
      // At least what the buffer keeps of an entry. The last 4 KB are only
      // shown to the redactor - see the next cases.
      expect(buffer.entries[0].text.length).toBeGreaterThanOrEqual(4 * 1024);
    });

    describe("a line cut at the cap", () => {
      it("sends nothing of a secret whose value the cut held back", () => {
        const service = build();

        // A streamed reply printed piece by piece: the cap falls right after
        // `password=`. Forwarded as a line of its own, the rest of it began
        // with the whole password.
        write(service, "x".repeat(8190) + " password=");
        write(service, "hunter2secret and more\n");

        expect(JSON.stringify(buffer.entries)).not.toContain("hunter2");
      });

      it("sends nothing of a secret the cut split", () => {
        const service = build();

        write(service, `${"a".repeat(8180)} apiKey="c0ffeec0ffee`);
        write(service, 'c0ffee" done\n');

        expect(buffer.entries.length).toBeGreaterThan(0);
        expect(JSON.stringify(buffer.entries)).not.toContain("c0ffee");
      });

      it("drops the rest of that line, then forwards the next as usual", () => {
        const service = build();

        write(service, "y".repeat(9 * 1024));
        write(service, "z".repeat(100));
        write(service, "zz\nnext line\n");

        expect(buffer.entries.map((entry) => entry.text[0])).toEqual([
          "y",
          "n",
        ]);
        expect(buffer.entries[1].text).toBe("next line");
      });

      it("forwards nothing for a cut line of only whitespace", () => {
        const service = build();

        write(service, " ".repeat(9 * 1024));

        expect(buffer.entries).toHaveLength(0);
      });

      it("keeps a stream's cut line apart from the other stream", () => {
        const service = build();

        write(service, "y".repeat(9 * 1024), "stdout");
        write(service, "on stderr\n", "stderr");

        expect(buffer.entries.map((entry) => entry.text.slice(0, 9))).toEqual([
          "yyyyyyyyy",
          "on stderr",
        ]);
      });
    });
  });

  describe("parsing", () => {
    it("carries level and context through from a Nest line", () => {
      const service = build();

      write(
        service,
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     WARN [OrdersService] slow query\n",
      );

      expect(buffer.entries[0]).toMatchObject({
        level: "warn",
        context: "OrdersService",
        text: "slow query",
      });
    });

    it.each([false, true])(
      "reads the level off every line ConsoleLogger prints (colors: %s)",
      (colors) => {
        const service = build();
        const logger = new ConsoleLogger("Ctx", { colors });
        // No-ops underneath the patch keep the lines out of the test output
        // while still exercising the real wrapper.
        const stdout = vi
          .spyOn(process.stdout, "write")
          .mockImplementation(() => true);
        const stderr = vi
          .spyOn(process.stderr, "write")
          .mockImplementation(() => true);

        try {
          service.start();
          logger.fatal("a fatal line");
          logger.error("an error line");
          logger.warn("a warn line");
          logger.log("a log line");
          logger.debug("a debug line");
          logger.verbose("a verbose line");
        } finally {
          service.onModuleDestroy();
          stdout.mockRestore();
          stderr.mockRestore();
        }

        // VERBOSE fills the seven columns Nest right-aligns the level in, so it
        // is the one level a single space follows the timestamp - and the one
        // that used to arrive with neither level nor context.
        expect(
          buffer.entries.map((entry) => [
            entry.level,
            entry.context,
            entry.text,
          ]),
        ).toEqual([
          ["fatal", "Ctx", "a fatal line"],
          ["error", "Ctx", "an error line"],
          ["warn", "Ctx", "a warn line"],
          ["log", "Ctx", "a log line"],
          ["debug", "Ctx", "a debug line"],
          ["verbose", "Ctx", "a verbose line"],
        ]);
      },
    );

    it("cuts a context to the length the collector accepts", () => {
      const service = build();

      write(
        service,
        `[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [${"A".repeat(300)}] done\n`,
      );

      // It refuses the whole batch over a longer one, traces and metrics
      // included.
      expect(buffer.entries[0].context).toHaveLength(255);
      expect(buffer.entries[0].text).toBe("done");
    });

    it("maps another logger's level onto one the collector accepts", () => {
      const service = build();

      write(
        service,
        `${JSON.stringify({ level: "info", message: "order placed" })}\n`,
      );

      // `info` as it was would get the whole batch refused.
      expect(buffer.entries[0].level).toBe("log");
    });

    it("forwards an unrecognised line with its full text", () => {
      const service = build();

      write(service, "npm warn deprecated foo@1.0.0\n");

      // A log the agent does not understand is still the log someone is
      // looking for.
      expect(buffer.entries[0].text).toBe("npm warn deprecated foo@1.0.0");
    });

    it("stamps every entry with a timestamp", () => {
      const service = build();

      write(service, "anything\n");

      expect(
        (buffer.entries[0] as unknown as { timestamp: number }).timestamp,
      ).toEqual(expect.any(Number));
    });
  });

  describe("lines written in pieces by several executions", () => {
    const inTrace = (traceId: string, run: () => void) =>
      als.run(new Map([[TRACE_ID_KEY, traceId]]), run);

    it("joins a piece only to the line its own execution started", () => {
      const service = build();

      // One request prints a reply piece by piece while another logs. Joined
      // to the other's line, the first pieces went out under its trace, in
      // front of a line that no longer parsed - and the rest of a secret
      // still being written went out alone, matching no rule.
      inTrace("trace-alice", () => write(service, "reply: password=hun"));
      inTrace("trace-bob", () =>
        write(
          service,
          "[Nest] 1  - 07/29/2026, 10:42:18 AM    WARN [Auth] login failed for bob\n",
        ),
      );
      inTrace("trace-alice", () => write(service, "ter2secret done\n"));

      expect(JSON.stringify(buffer.entries)).not.toContain("ter2secret");
      expect(buffer.entries).toMatchObject([
        {
          traceId: "trace-bob",
          level: "warn",
          context: "Auth",
          text: "login failed for bob",
        },
        { traceId: "trace-alice", text: "reply: password=[REDACTED] done" },
      ]);
    });

    it("joins the pieces one execution writes from different spans", () => {
      const service = build();

      // The store is copied for every span, so it is the trace that says
      // whose line a piece belongs to, not the store object.
      als.run(new Map([[TRACE_ID_KEY, "trace-1"]]), () =>
        write(service, "hel"),
      );
      als.run(
        new Map([
          [TRACE_ID_KEY, "trace-1"],
          [CALLER_METADATA_KEY, "span-2"],
        ]),
        () => write(service, "lo\n"),
      );

      expect(buffer.entries).toMatchObject([
        { text: "hello", traceId: "trace-1", spanId: "span-2" },
      ]);
    });

    it("drops the rest of a line cut at the cap for its own execution only", () => {
      const service = build();

      inTrace("trace-alice", () => write(service, "y".repeat(9 * 1024)));
      inTrace("trace-bob", () => write(service, "from bob\n"));
      inTrace("trace-alice", () => write(service, "rest of it\nnext\n"));

      expect(
        buffer.entries.map((entry) => [entry.traceId, entry.text.slice(0, 8)]),
      ).toEqual([
        ["trace-alice", "yyyyyyyy"],
        ["trace-bob", "from bob"],
        ["trace-alice", "next"],
      ]);
    });

    it("forwards the line held longest once too many are held", () => {
      const service = build();

      // An execution that ends without its newline leaves its line behind.
      for (let i = 0; i < 65; i++) {
        inTrace(`trace-${i}`, () => write(service, `piece ${i}`));
      }

      expect(buffer.entries).toMatchObject([
        { text: "piece 0", traceId: "trace-0" },
      ]);
    });

    it("files a line forwarded on shutdown under the trace that wrote it", () => {
      const service = build();

      service.start();
      inTrace("trace-late", () => {
        process.stdout.write("no newline yet");
      });
      service.onModuleDestroy();

      expect(
        buffer.entries.find((entry) => entry.text === "no newline yet"),
      ).toMatchObject({ traceId: "trace-late" });
    });
  });

  describe("trace attribution", () => {
    it("takes the trace and span from the async store", () => {
      const service = build();

      als.run(
        new Map([
          [TRACE_ID_KEY, "trace-from-store"],
          [CALLER_METADATA_KEY, "span-1"],
        ]),
        () => write(service, "inside a span\n"),
      );

      expect(buffer.entries[0]).toMatchObject({
        traceId: "trace-from-store",
        spanId: "span-1",
      });
    });

    it("prefers a trace id carried on the line itself", () => {
      const service = build();

      als.run(new Map([[TRACE_ID_KEY, "trace-from-store"]]), () =>
        write(
          service,
          "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: trace-on-line\n",
        ),
      );

      // The line's id was captured when the log was written; the store is read
      // now and may already have moved on.
      expect(buffer.entries[0].traceId).toBe("trace-on-line");
    });

    it("drops the span id when the line belongs to a different trace", () => {
      const service = build();

      als.run(
        new Map([
          [TRACE_ID_KEY, "trace-from-store"],
          [CALLER_METADATA_KEY, "span-of-other-operation"],
        ]),
        () =>
          write(
            service,
            "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: trace-on-line\n",
          ),
      );

      // Naming the store's span here would file the line under a span it was
      // never written inside.
      expect(buffer.entries[0].spanId).toBeUndefined();
    });

    it.each([
      ["longer than the collector accepts", "T".repeat(300)],
      ["made of characters no trace id is", "trace#1"],
    ])(
      "falls back to the store when the line's trace id is %s",
      (_, lineTraceId) => {
        const service = build();

        als.run(
          new Map([
            [TRACE_ID_KEY, "trace-from-store"],
            [CALLER_METADATA_KEY, "span-1"],
          ]),
          () =>
            write(
              service,
              `[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [Ctx] done Trace ID: ${lineTraceId}\n`,
            ),
        );

        // Anyone who gets a newline into a logged value can end a line with a
        // `Trace ID:` of their choosing, so it is held to the rule a client's
        // `x-request-id` is - and an over-long one would get the whole batch
        // refused.
        expect(buffer.entries[0]).toMatchObject({
          traceId: "trace-from-store",
          spanId: "span-1",
        });
      },
    );

    it("forwards a line written outside any trace", () => {
      const service = build();

      write(service, "no async context here\n");

      expect(buffer.entries[0].traceId).toBeUndefined();
      expect(buffer.entries[0].spanId).toBeUndefined();
    });
  });

  describe("redaction", () => {
    it("redacts the message before it reaches the buffer", () => {
      const service = build();

      write(service, "signing in with password=hunter2\n");

      // Before the buffer, which is also before the buffer truncates oversized
      // lines - truncating first would cut a long secret in half and ship the
      // surviving half.
      expect(buffer.entries[0].text).not.toContain("hunter2");
    });

    it("redacts attributes on a structured line", () => {
      const service = build();

      write(
        service,
        `${JSON.stringify({
          level: "info",
          message: "auth attempt",
          password: "hunter2",
        })}\n`,
      );

      expect(JSON.stringify(buffer.entries[0])).not.toContain("hunter2");
    });

    it("redacts the context too", () => {
      const service = build();

      // Nest takes a trailing string argument as the context, so a secret
      // passed there lands in the brackets.
      write(
        service,
        "[Nest] 1  - 07/29/2026, 10:42:18 AM     LOG [token=abc123secret] login\n",
      );

      expect(buffer.entries[0].context).toBe("token=[REDACTED]");
    });

    it("is on by default, because forwarding moves logs onto another machine", () => {
      const service = build({ redaction: undefined });

      write(service, "token=abcdef123456\n");

      expect(buffer.entries[0].text).not.toContain("abcdef123456");
    });

    it("can be switched off explicitly", () => {
      const service = build({ redaction: { enabled: false } });

      write(service, "password=hunter2\n");

      expect(buffer.entries[0].text).toContain("hunter2");
    });

    it("honours custom redaction options", () => {
      const service = build({
        redaction: { replacement: "***" },
      });

      write(service, "password=hunter2\n");

      expect(buffer.entries[0].text).toContain("***");
    });

    describe("a message written over several lines", () => {
      const NEST = "[Nest] 1  - 07/29/2026, 10:42:18 AM";
      const body = [
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj",
        "MzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDuictGeurT8jNbvJZHtCSuYEvu",
        "NMoSfm76oqFvAp8Gy0iz5sxjZmSnXyCdPEovGhLa0VzMaQ8s+CLOyS56YyCFGeJZ",
      ];
      const pem = [
        "-----BEGIN PRIVATE KEY-----",
        ...body,
        "-----END PRIVATE KEY-----",
      ].join("\n");

      it("redacts a private key logged in its own layout", () => {
        const service = build();

        // Redacted a line at a time, the key's lines were never seen
        // together, and each one shipped - while the trace of the same
        // request, redacted whole, had it masked.
        write(service, `${NEST}    WARN [Deploy] Cannot import key: ${pem}\n`);

        const sent = JSON.stringify(buffer.entries);
        for (const line of body) {
          expect(sent).not.toContain(line.slice(0, 16));
        }
        expect(buffer.entries[0]).toMatchObject({
          level: "warn",
          context: "Deploy",
        });
        expect(buffer.entries[0].text).toMatch(/^Cannot import key: /);
      });

      it("redacts a quoted value cut by a line break as far as the redactor reads it", () => {
        const service = build();

        write(
          service,
          'Error: secret="aGVsbG8gd29ybGQgaGVsbG8g\nd29ybGQ=" is not base64url\n    at main (/app/main.js:1:1)\n',
        );

        // The lines go to the redactor as the one text they were written as;
        // how far a quoted value runs is its rule's to say, and it ends one
        // left open at the end of its line - so the line under it is the
        // redactor's to mask, not the forwarder's.
        const sent = JSON.stringify(buffer.entries);
        expect(sent).not.toContain("aGVsbG8");
        expect(buffer.entries[0].text).toBe("Error: secret=[REDACTED]");
      });

      it("keeps a line that has a prefix of its own apart", () => {
        const service = build();

        write(
          service,
          `${NEST}     LOG [First] password:\n${NEST}     LOG [Second] ready\n`,
        );

        expect(buffer.entries).toMatchObject([
          { context: "First", text: "password:" },
          { context: "Second", text: "ready", level: "log" },
        ]);
      });

      it("keeps a JSON record one entry, and apart from the lines under it", () => {
        const service = build();

        write(
          service,
          `${JSON.stringify({ level: "info", message: "a\nb" })}\nplain under it\n`,
        );

        expect(buffer.entries.map((entry) => entry.text)).toEqual([
          "a\nb",
          "plain under it",
        ]);
      });

      it("redacts a value the per-write cap cut, with the lines past it", () => {
        const service = build();

        const filler = Array.from({ length: 48 }, (_, i) => `step ${i}`);
        write(
          service,
          [
            ...filler,
            'secret="aGVsbG8gd29ybGQgaGVsbG8g',
            'd29ybGQ="',
            ...filler,
          ].join("\n") + "\n",
        );

        expect(buffer.entries).toHaveLength(50);
        expect(JSON.stringify(buffer.entries)).not.toContain("aGVsbG8");
        expect(buffer.entries[48].text).toBe("secret=[REDACTED]");
      });
    });

    describe("an over-long line", () => {
      const password = "Pw-0123456789abcdef0123456789abcdef";

      it("is still read as the structured line it is", () => {
        const service = build();

        // Cut before it was parsed, a long JSON line was no longer JSON: it
        // went out as raw text, where nothing masks by key, and
        // `passwordConfirmation` with it.
        als.run(new Map([[TRACE_ID_KEY, "trace-signup"]]), () =>
          write(
            service,
            `${JSON.stringify({
              level: "warn",
              message: "signup rejected",
              context: "SignupController",
              form: {
                password,
                passwordConfirmation: password,
                bio: "x".repeat(17_000),
              },
            })}\n`,
          ),
        );

        expect(buffer.entries).toHaveLength(1);
        expect(JSON.stringify(buffer.entries[0])).not.toContain("Pw-0123");
        expect(buffer.entries[0]).toMatchObject({
          text: "signup rejected",
          level: "warn",
          context: "SignupController",
          traceId: "trace-signup",
        });
        // Sent without them: every string in them would need the window too.
        expect(buffer.entries[0].attributes).toBeUndefined();
      });

      it("never sends a secret the redactor's window cut in two", () => {
        const service = build();

        // `token=AAAA…` shrinks to `token=[REDACTED]`, which pulls whatever
        // sat at the window's edge into what ships - here the first 17
        // characters of a quoted key whose closing quote lay past the edge.
        const key = "c0ffee".repeat(10);
        const padding = 16 * 1024 - "token=".length - ' apiKey="'.length - 17;
        write(service, `token=${"A".repeat(padding)} apiKey="${key}" done\n`);

        expect(buffer.entries).toHaveLength(1);
        expect(buffer.entries[0].text).toMatch(/^token=\[REDACTED\]/);
        expect(buffer.entries[0].text).not.toContain("c0ffee");
      });

      it("keeps a secret that lies whole inside the window masked", () => {
        const service = build();

        write(service, `password=hunter2secret ${"word ".repeat(5_000)}\n`);

        expect(buffer.entries[0].text).toMatch(/^password=\[REDACTED\] word/);
        expect(buffer.entries[0].text).not.toContain("hunter2");
      });

      it("bounds the context as it bounds the message", () => {
        const service = build();

        write(
          service,
          `${JSON.stringify({
            level: "info",
            message: "ready",
            context: `token=${"B".repeat(20_000)}`,
          })}\n`,
        );

        expect(buffer.entries[0].context).toBe("token=[REDACTED]");
      });

      it("is cut, unredacted, when redaction is off", () => {
        const service = build({ redaction: { enabled: false } });

        write(service, `password=hunter2 ${"y".repeat(20_000)}\n`);

        expect(buffer.entries[0].text).toMatch(/^password=hunter2 y/);
        expect(buffer.entries[0].text.length).toBeLessThanOrEqual(16 * 1024);
      });
    });
  });

  describe("patching stdout", () => {
    it("says log lines are forwarded only when they are", () => {
      const debugOf = (service: StdoutForwarderService) =>
        vi
          .spyOn((service as unknown as { logger: Logger }).logger, "debug")
          .mockImplementation(() => {});

      const idle = build({ debug: true });
      const idleDebug = debugOf(idle);
      idle.onModuleInit();

      const forwarding = build({ debug: true, forwardLogs: true });
      try {
        const forwardingDebug = debugOf(forwarding);
        forwarding.onModuleInit();

        // It used to say forwarding was enabled under `debug` alone, so a
        // service sending nothing told whoever was debugging it otherwise.
        expect(idleDebug).not.toHaveBeenCalled();
        expect(forwardingDebug).toHaveBeenCalledWith(
          expect.stringContaining("Forwarding log lines"),
        );
      } finally {
        forwarding.onModuleDestroy();
      }
    });

    it("leaves stdout alone when the agent is disabled", () => {
      const original = process.stdout.write;
      const service = build({ enabled: false, forwardLogs: true });
      try {
        expect(process.stdout.write).toBe(original);
      } finally {
        service.onModuleDestroy();
      }
    });

    it("forwards writes and leaves stdout working", () => {
      const service = build();
      const original = process.stdout.write;

      service.start();
      try {
        expect(process.stdout.write).not.toBe(original);
        process.stdout.write("patched line\n");
      } finally {
        service.onModuleDestroy();
      }

      // Exactly the original reference, not a bound copy of it: repeated
      // start/restore cycles must not leave a stack of `bind` wrappers behind.
      expect(process.stdout.write).toBe(original);
      expect(buffer.entries.map((entry) => entry.text)).toContain(
        "patched line",
      );
    });

    it("forwards stderr too, so error lines are not lost", () => {
      const service = build();
      // ConsoleLogger writes `error` to stderr and every other level to stdout.
      const logger = new ConsoleLogger("Payments", { json: true });
      // A no-op underneath the patch keeps the stack trace out of the test
      // output while still exercising the real wrapper.
      const realStderr = process.stderr.write;
      const silent = (() => true) as typeof process.stderr.write;
      process.stderr.write = silent;

      try {
        service.start();
        expect(process.stderr.write).not.toBe(silent);
        logger.error("charge failed", new Error("declined").stack);
        service.onModuleDestroy();
        expect(process.stderr.write).toBe(silent);
      } finally {
        process.stderr.write = realStderr;
      }

      expect(
        buffer.entries.map((entry) => [entry.level, entry.text]),
      ).toContainEqual(["error", "charge failed"]);
    });

    it("keeps a fragment on stdout apart from one on stderr", () => {
      const service = build();

      write(service, "half of stdout ", "stdout");
      write(service, "half of stderr ", "stderr");
      write(service, "done\n", "stdout");
      write(service, "done\n", "stderr");

      expect(buffer.entries.map((entry) => entry.text)).toEqual([
        "half of stdout done",
        "half of stderr done",
      ]);
    });

    it("does not patch twice", () => {
      const service = build();

      service.start();
      const patched = process.stdout.write;
      service.start();

      try {
        expect(process.stdout.write).toBe(patched);
      } finally {
        service.onModuleDestroy();
      }
    });

    it("keeps stdout working when forwarding throws", () => {
      const service = build();
      vi.spyOn(buffer, "pushLogs").mockImplementation(() => {
        throw new Error("buffer exploded");
      });

      service.start();
      try {
        // A forwarding failure must never take down the write it wrapped, and
        // logging the failure here would re-enter this same patched write.
        expect(() => process.stdout.write("still works\n")).not.toThrow();
      } finally {
        service.onModuleDestroy();
      }
    });

    it("flushes a held fragment on shutdown", () => {
      const service = build();

      service.start();
      process.stdout.write("no newline yet");
      service.onModuleDestroy();

      // Otherwise the last thing a crashing process wrote is the thing that
      // never arrives.
      expect(buffer.entries.map((entry) => entry.text)).toContain(
        "no newline yet",
      );
    });

    it("survives repeated start and restore cycles", () => {
      const original = process.stdout.write;
      const originalStderr = process.stderr.write;

      for (let i = 0; i < 3; i++) {
        const service = build();
        service.start();
        service.onModuleDestroy();
      }

      expect(process.stdout.write).toBe(original);
      expect(process.stderr.write).toBe(originalStderr);
    });

    it("restores stdout even if it was never patched", () => {
      const service = build();
      const original = process.stdout.write;

      expect(() => service.onModuleDestroy()).not.toThrow();
      expect(process.stdout.write).toBe(original);
    });
  });
});
