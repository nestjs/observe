import {
  copyStore,
  getThroughCopies,
  setThroughCopies,
} from "./store-copy.util.js";

describe("store copies", () => {
  it("copies a store with the entries given over it", () => {
    const store = new Map<string, unknown>([
      ["#caller", "a"],
      ["tenantId", "acme"],
    ]);

    const copy = copyStore(store, ["#caller", "b"]);

    expect([...copy]).toEqual([
      ["#caller", "b"],
      ["tenantId", "acme"],
    ]);
    expect(store.get("#caller")).toBe("a");
  });

  it("writes through every store a copy was made from, and nothing beside them", () => {
    const root = new Map<string, unknown>();
    const child = copyStore(root);
    const grandchild = copyStore(child);
    const sibling = copyStore(root);

    setThroughCopies(grandchild, "tenantId", "acme");

    expect(grandchild.get("tenantId")).toBe("acme");
    expect(child.get("tenantId")).toBe("acme");
    expect(root.get("tenantId")).toBe("acme");
    expect(sibling.has("tenantId")).toBe(false);
    expect(getThroughCopies(sibling, "tenantId")).toBe("acme");
  });

  it("reads the store itself before the stores it was copied from", () => {
    const root = new Map<string, unknown>([["plan", "free"]]);
    const copy = copyStore(root);
    root.set("plan", "pro");

    expect(getThroughCopies(copy, "plan")).toBe("free");
    copy.delete("plan");
    expect(getThroughCopies(copy, "plan")).toBe("pro");
    expect(getThroughCopies(copy, "missing")).toBeUndefined();
  });
});
