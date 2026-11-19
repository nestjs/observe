/**
 * The instance behind each proxy the instance decorator hands out for a class
 * whose methods only the instance itself can be the receiver of: one with
 * private members, or one built on a slot-backed built-in.
 *
 * The proxy runs every method read through it against that instance. A
 * method read anywhere else - off the class prototype - and applied to the
 * proxy gets no such help, and throws on its first `this.#x`. Whoever has to
 * apply one that way asks here for the receiver to use instead.
 *
 * Kept out of the decorator's module, which the package exports in full: the
 * instance behind a proxy is the agent's to hand over, not an application's
 * to look up. Module-level and weak, so a proxy names its instance for as
 * long as the two live, whichever agent made it.
 */
const rawReceivers = new WeakMap<object, object>();

export function registerRawReceiver(proxy: object, instance: object): void {
  rawReceivers.set(proxy, instance);
}

/**
 * The instance a provider's prototype methods have to be applied to, when
 * that is not the provider itself - `undefined` for anything else.
 */
export function rawReceiverOf(provider: object): object | undefined {
  let receiver = rawReceivers.get(provider);
  // A provider handed out a second time (`useExisting`, a factory returning
  // another provider) is a proxy of the first proxy.
  while (receiver !== undefined && rawReceivers.has(receiver)) {
    receiver = rawReceivers.get(receiver);
  }
  return receiver;
}
