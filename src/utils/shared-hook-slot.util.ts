/**
 * Shares a hook slot of Nest's with the application.
 *
 * Nest keeps several hooks one to a slot, behind a public setter: the GraphQL
 * host's request hooks, an HTTP adapter's request hooks, a microservice
 * server's processing hooks, a client's dispatch hook. The slot is the
 * application's to use as much as the agent's, and whichever of them called
 * the setter last was the only one left. Here the setter on the instance is
 * shadowed by one that records the application's hook, and what Nest is
 * given, through the setter it had, is one function running both: the
 * application's hook and the agent's part, as `compose` puts them together.
 * The agent sets its part with `setAgentHook` and never through the setter,
 * so either may come first.
 *
 * What is kept lives on the instance under a registered symbol, so a second
 * agent - another application built on the same adapter, another copy of
 * this package - replaces the agent's part instead of taking the first
 * agent's pair for the application's hook.
 */

export type Hook = (this: unknown, ...args: any[]) => unknown;

/** What the slot holds: the application's hook, if any, and the agent's part. */
export type ComposeHooks<H extends Hook> = (
  application: H | undefined,
  agent: H,
) => H;

export interface SharedSlotOptions {
  /**
   * The slot's public getter, where Nest has one. What it returns when the
   * slot is first shared is a hook set before: the application's.
   */
  getter?: string;
  /**
   * Points the getter at the application's own hook, for a slot Nest reads
   * through something else: an application chaining "the previous hook" is
   * handed its own, not the pair that runs the agent's part as well.
   */
  repointGetter?: boolean;
}

interface HookSlot {
  application: unknown;
  agent: Hook | undefined;
  compose: ComposeHooks<Hook> | undefined;
  /** The setter the instance had, called on the instance itself. */
  install: (hook: unknown) => void;
}

const SHARED_HOOK_SLOTS = Symbol.for("nestjs.observe.sharedHookSlots");

/**
 * Takes over `target[setter]`, once per instance; `false` when the instance
 * has no such setter or cannot be written to. A hook set through the setter
 * from then on is the application's.
 */
export function shareHookSlot(
  target: object,
  setter: string,
  options: SharedSlotOptions = {},
): boolean {
  return findOrShare(target, setter, options) !== undefined;
}

/**
 * Sets the agent's part of the slot, sharing it first if need be. On an
 * instance that cannot be shared, the agent's part is set through the setter
 * as it is - in place of whatever was there, as before slots were shared.
 * Never throws: the callers run while Nest builds the application.
 */
export function setAgentHook<H extends Hook>(
  target: object,
  setter: string,
  agent: H,
  compose: ComposeHooks<H>,
  options: SharedSlotOptions = {},
): void {
  const slot = findOrShare(target, setter, options);
  try {
    if (!slot) {
      (target as Record<string, Hook>)[setter](compose(undefined, agent));
      return;
    }
    slot.agent = agent;
    slot.compose = compose as unknown as ComposeHooks<Hook>;
    fill(slot);
  } catch {
    // A setter that throws leaves that slot to whoever had it.
  }
}

function findOrShare(
  target: object,
  setter: string,
  { getter, repointGetter }: SharedSlotOptions,
): HookSlot | undefined {
  try {
    const instance = target as Record<string | symbol, unknown>;
    const slots = Object.prototype.hasOwnProperty.call(
      instance,
      SHARED_HOOK_SLOTS,
    )
      ? (instance[SHARED_HOOK_SLOTS] as Record<string, HookSlot>)
      : undefined;
    if (slots?.[setter]) {
      return slots[setter];
    }
    const original = instance[setter];
    if (typeof original !== "function") {
      return undefined;
    }
    const read = getter ? instance[getter] : undefined;
    const slot: HookSlot = {
      application: typeof read === "function" ? read.call(target) : undefined,
      agent: undefined,
      compose: undefined,
      install: (hook) => original.call(target, hook),
    };
    defineHidden(
      target,
      SHARED_HOOK_SLOTS,
      Object.assign(Object.create(null), slots, { [setter]: slot }),
    );
    // Called on the instance it was taken from, never on `this`: the setter
    // may be reached through a proxy of the instance, ours or Nest's.
    defineHidden(target, setter, function (hook: unknown) {
      slot.application = hook;
      fill(slot);
    });
    if (getter && repointGetter && typeof read === "function") {
      defineHidden(target, getter, () => slot.application);
    }
    return slot;
  } catch {
    // Frozen, or a proxy that refuses the definition.
    return undefined;
  }
}

/** Hands Nest the slot's current pair, or the application's hook alone. */
function fill(slot: HookSlot): void {
  const application =
    typeof slot.application === "function"
      ? (slot.application as Hook)
      : undefined;
  slot.install(
    slot.agent && slot.compose
      ? slot.compose(application, slot.agent)
      : slot.application,
  );
}

function defineHidden(target: object, key: string | symbol, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}
