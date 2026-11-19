import { readContextAccessor } from "./context-accessor.util.js";

describe("readContextAccessor", () => {
  it("answers what the accessor returns", () => {
    expect(
      readContextAccessor({ getPattern: () => "orders.created" }, "getPattern"),
    ).toBe("orders.created");
  });

  it("answers nothing for a context without the accessor", () => {
    for (const context of [undefined, null, {}, { getPattern: "orders" }]) {
      expect(readContextAccessor(context, "getPattern")).toBeUndefined();
    }
  });

  it("answers nothing for an asynchronous accessor, and handles its rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      // A custom transporter's context that checks the message's signature
      // before answering, and rejects a forged one.
      const context = {
        getPattern: () => Promise.reject(new Error("no pattern")),
      };

      expect(readContextAccessor(context, "getPattern")).toBeUndefined();
      // An unhandled rejection is reported once the microtasks have run.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
