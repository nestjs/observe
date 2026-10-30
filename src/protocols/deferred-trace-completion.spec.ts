import type { Logger } from "@nestjs/common";
import {
  deferTraceCompletion,
  generateTraceIdSafely,
  getUserIdSafely,
  invokeUserCallbackSafely,
  setAttributesSafely,
  shouldIgnoreSafely,
} from "./deferred-trace-completion.js";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * A new callback on every call: failures are reported once per callback, so a
 * callback shared between tests would leave the later ones nothing to report.
 */
const throwing =
  (error: unknown = new Error("callback failed")) =>
  (): never => {
    throw error;
  };

describe("invokeUserCallbackSafely", () => {
  let warn: ReturnType<typeof vi.fn>;
  let logger: Logger;

  beforeEach(() => {
    warn = vi.fn();
    logger = { warn } as unknown as Logger;
  });

  const invoke = <TArgs extends unknown[], TResult>(
    callback: (...args: TArgs) => TResult,
    args: TArgs,
    receiver: unknown = null,
  ) =>
    invokeUserCallbackSafely(
      callback,
      args,
      receiver,
      () => "fallback",
      logger,
      "http.ignore",
      "not tracing the operation",
    );

  it("passes the arguments and the configured receiver through", () => {
    const receiver = { prefix: "order" };
    const callback = function (this: typeof receiver, id: number) {
      return `${this.prefix}-${id}`;
    };

    expect(invoke(callback, [42], receiver)).toBe("order-42");
    expect(warn).not.toHaveBeenCalled();
  });

  it("answers the fallback, and reports only the first failure", () => {
    const callback = throwing(new Error("no such header"));

    expect(invoke(callback, [])).toBe("fallback");
    expect(invoke(callback, [])).toBe("fallback");

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      '"http.ignore" threw; not tracing the operation. Later failures are not reported: no such header',
    );
  });

  it("contains errors that cannot be formatted safely", () => {
    const callback = throwing({
      toString: () => {
        throw new Error("format failed");
      },
    });

    expect(invoke(callback, [])).toBe("fallback");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("an unprintable error"),
    );
  });

  it("answers the fallback when the logger throws as well", () => {
    logger = {
      warn: () => {
        throw new Error("logger failed");
      },
    } as unknown as Logger;

    expect(invoke(throwing(), [])).toBe("fallback");
  });
});

describe("what each callback falls back to", () => {
  const logger = { warn: vi.fn() } as unknown as Logger;

  it("traceIdGenerator: a fresh uuidv7", () => {
    expect(generateTraceIdSafely(throwing(), {}, null, logger)).toMatch(
      UUID_V7,
    );
  });

  it("setAttributes: the store as it was", () => {
    const store = new Map<string, unknown>([["tenant", "acme"]]);

    setAttributesSafely(throwing(), [], null, store, logger, "http");
    setAttributesSafely(
      () => ({ region: "eu" }),
      [],
      null,
      store,
      logger,
      "http",
    );

    expect(Object.fromEntries(store)).toEqual({ tenant: "acme", region: "eu" });
  });

  it("ignore: excluding the operation", () => {
    expect(shouldIgnoreSafely(throwing(), [], null, logger, "http")).toBe(true);
    // Nothing configured still excludes nothing.
    expect(shouldIgnoreSafely(undefined, [], null, logger, "http")).toBe(false);
  });

  it("getUserId: no user id", () => {
    expect(
      getUserIdSafely(throwing(), [], null, logger, "http"),
    ).toBeUndefined();
  });
});

describe("deferTraceCompletion", () => {
  const quiet = { warn: vi.fn() } as unknown as Logger;
  /** Lets queued microtasks - and the ones they queue - run. */
  const settleMicrotasks = async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes without a timer once every span has closed", async () => {
    vi.useFakeTimers();
    const completion = vi.fn(() => Promise.resolve());

    deferTraceCompletion(completion, quiet, "http", () => false);
    await settleMicrotasks();

    expect(completion).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives a span still open the moment of a timer to close", async () => {
    vi.useFakeTimers();
    const completion = vi.fn(() => Promise.resolve());

    deferTraceCompletion(completion, quiet, "http", () => true);
    await settleMicrotasks();
    expect(completion).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(completion).toHaveBeenCalledOnce();
  });

  it("asks about open spans after the rest of the event's listeners ran", async () => {
    vi.useFakeTimers();
    const completion = vi.fn(() => Promise.resolve());
    let open = false;

    deferTraceCompletion(completion, quiet, "http", () => open);
    // A later listener of the same event starts a span synchronously.
    open = true;
    await settleMicrotasks();
    expect(completion).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(completion).toHaveBeenCalledOnce();
  });

  it("consumes rejected deferred completion and warns once", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    deferTraceCompletion(
      () => Promise.reject(new Error("completion failed")),
      logger,
      "http",
    );
    deferTraceCompletion(
      () => Promise.reject(new Error("completion failed")),
      logger,
      "http",
    );
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});
