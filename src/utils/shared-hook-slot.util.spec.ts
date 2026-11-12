import {
  ComposeHooks,
  setAgentHook,
  shareHookSlot,
} from "./shared-hook-slot.util.js";

type Hook = (calls: string[]) => void;

/** A slot as Nest writes one: a plain setter, and a getter where it has one. */
class Host {
  hook: Hook | undefined;

  setHook(hook: Hook | undefined) {
    this.hook = hook;
  }

  getHook() {
    return this.hook;
  }

  run() {
    const calls: string[] = [];
    this.hook?.(calls);
    return calls;
  }
}

const both: ComposeHooks<Hook> = (application, agent) => (calls) => {
  application?.(calls);
  agent(calls);
};

const named =
  (name: string): Hook =>
  (calls) => {
    calls.push(name);
  };

describe("shared hook slots", () => {
  it("runs a hook the application sets after the agent's, beside it", () => {
    const host = new Host();
    setAgentHook(host, "setHook", named("agent"), both);
    host.setHook(named("app"));

    expect(host.run()).toEqual(["app", "agent"]);
  });

  it("runs one set before, when the slot was shared first", () => {
    const host = new Host();
    shareHookSlot(host, "setHook");
    host.setHook(named("app"));
    // Nothing is composed until the agent sets its part.
    expect(host.run()).toEqual(["app"]);

    setAgentHook(host, "setHook", named("agent"), both);

    expect(host.run()).toEqual(["app", "agent"]);
  });

  it("reads a hook set before the slot was shared through its getter", () => {
    const host = new Host();
    host.setHook(named("app"));
    setAgentHook(host, "setHook", named("agent"), both, { getter: "getHook" });

    expect(host.run()).toEqual(["app", "agent"]);
    // Left alone unless asked: Nest may read the slot through it.
    expect(host.getHook()).toBe(host.hook);
  });

  it("points the getter at the application's own hook when asked", () => {
    const host = new Host();
    const app = named("app");
    setAgentHook(host, "setHook", named("agent"), both, {
      getter: "getHook",
      repointGetter: true,
    });
    host.setHook(app);

    expect(host.getHook()).toBe(app);
  });

  it("drops the application's part when it clears the slot", () => {
    const host = new Host();
    setAgentHook(host, "setHook", named("agent"), both);
    host.setHook(named("app"));
    host.setHook(undefined);

    expect(host.run()).toEqual(["agent"]);
  });

  it("replaces the part an earlier agent set instead of nesting it", () => {
    const host = new Host();
    host.setHook(named("app"));
    setAgentHook(host, "setHook", named("first"), both, { getter: "getHook" });
    setAgentHook(host, "setHook", named("second"), both, {
      getter: "getHook",
    });

    expect(host.run()).toEqual(["app", "second"]);
  });

  it("writes to the instance it shared when the setter is reached through a proxy", () => {
    const host = new Host();
    setAgentHook(host, "setHook", named("agent"), both);
    const proxy = new Proxy(host, {});
    proxy.setHook(named("app"));

    expect(host.run()).toEqual(["app", "agent"]);
    expect(Object.keys(host)).toEqual(["hook"]);
  });

  it("sets the agent's part alone on an instance it cannot write to", () => {
    const host = Object.freeze(new Host());
    expect(shareHookSlot(host, "setHook")).toBe(false);

    // The setter writes to a field a frozen object refuses too.
    expect(() =>
      setAgentHook(host, "setHook", named("agent"), both),
    ).not.toThrow();
  });

  it("leaves an instance without the setter alone", () => {
    const host = {};
    expect(shareHookSlot(host, "setHook")).toBe(false);
    expect(() =>
      setAgentHook(host, "setHook", named("agent"), both),
    ).not.toThrow();
    expect(Reflect.ownKeys(host)).toEqual([]);
  });
});
