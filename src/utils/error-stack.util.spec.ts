import { readStack, rewriteStackFrames } from "./error-stack.util.js";

/**
 * V8 writes the first line of a stack from the error's name and message when
 * the stack is first read. The agent reads it long before the application
 * does, and that must not be the read that counts.
 */
describe("an error's stack in the agent's hands", () => {
  const firstLine = (stack: unknown) => String(stack).split("\n")[0];

  it("leaves the first line to be written when the application reads it", () => {
    const error = new Error("no person with national id 19850101-7731");

    expect(firstLine(readStack(error))).toBe(
      "Error: no person with national id 19850101-7731",
    );
    error.message = "no person with national id <national id>";

    expect(firstLine(readStack(error))).toBe(
      "Error: no person with national id <national id>",
    );
    expect(firstLine(error.stack)).toBe(
      "Error: no person with national id <national id>",
    );
  });

  it("fixes the first line at the application's read, as V8 does", () => {
    const error = new Error("first");
    readStack(error);
    error.message = "second";

    const read = error.stack;
    error.message = "third";

    expect(firstLine(read)).toBe("Error: second");
    expect(error.stack).toBe(read);
    expect(readStack(error)).toBe(read);
    expect(Object.getOwnPropertyDescriptor(error, "stack")).toMatchObject({
      value: read,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  });

  it("keeps the message as it was, own or inherited", () => {
    const withMessage = new Error("kept");
    const withoutMessage = new Error();

    readStack(withMessage);
    readStack(withoutMessage);

    expect(withMessage.message).toBe("kept");
    expect(Object.hasOwn(withoutMessage, "message")).toBe(false);
    expect(firstLine(withoutMessage.stack)).toBe("Error");
  });

  it("rewrites the frames and nothing of the message", () => {
    const error = new Error("failed\n    at Proxy.find (in a message)");
    const untouched = new Error(error.message);
    const native = untouched.stack!;

    rewriteStackFrames(error, (frames) =>
      frames.replace(/(\n {4}at )Proxy\.find \(/, "$1UserService.find ("),
    );
    error.name = "LookupError";

    expect(firstLine(error.stack)).toBe("LookupError: failed");
    expect(error.stack).toContain("at Proxy.find (in a message)");
    expect(error.stack).not.toContain("UserService.find (in a message)");
    expect(native).toContain("at Proxy.find (in a message)");
  });

  it("follows the message of one of Node's own errors", () => {
    let error: Error | undefined;
    try {
      Buffer.from("", "no-such-encoding" as BufferEncoding);
    } catch (thrown) {
      error = thrown as Error;
    }

    readStack(error!);
    error!.message = "masked";

    expect(firstLine(error!.stack)).toBe(
      "TypeError [ERR_UNKNOWN_ENCODING]: masked",
    );
  });

  it("leaves a stack that was read before as it is", () => {
    // mysql2's promise wrapper assigns the stack of its errors: a later
    // change of the message never reached it, with or without the agent.
    const error = new Error("before");
    const stack = error.stack;
    error.message = "after";

    expect(readStack(error)).toBe(stack);
    expect(error.stack).toBe(stack);
  });

  it("gives way to a stack the application assigns", () => {
    const error = new Error("boom");
    readStack(error);

    error.stack = "Error: boom\n    at somewhere else";
    error.message = "changed";
    rewriteStackFrames(error, (stack) => stack.replace("else", "entirely"));

    expect(readStack(error)).toBe("Error: boom\n    at somewhere entirely");
    expect(error.stack).toBe("Error: boom\n    at somewhere entirely");
  });

  it("reads the stack of a sealed error as it is", () => {
    const error = Object.seal(new Error("sealed"));

    expect(firstLine(readStack(error))).toBe("Error: sealed");
    expect(() =>
      rewriteStackFrames(error, (stack) => stack.replace(" at ", " in ")),
    ).not.toThrow();
  });
});
