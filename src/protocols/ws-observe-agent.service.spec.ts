import { AsyncLocalStorage } from "async_hooks";
import { EventEmitter } from "events";
import { defer, from, isObservable, Observable, Subject } from "rxjs";
import { WsObserveAgentService } from "./ws-observe-agent.service.js";

type GatewayHandler = (...args: unknown[]) => unknown;

/**
 * The agent's side of a gateway message, against a stand-in for Nest's
 * `WsContextCreator` and a registry that only records what it is told. The
 * adapters themselves are exercised by the ws int-specs; these are the cases a
 * running gateway does not produce on demand - a client that is gone before
 * its message is traced, one that is no event emitter, a chain the adapter
 * lets go of before it says anything.
 */
describe("WsObserveAgentService", () => {
  let registry: {
    startTrace: ReturnType<typeof vi.fn>;
    endTrace: ReturnType<typeof vi.fn>;
    abandonTrace: ReturnType<typeof vi.fn>;
    pluckSnapshot: ReturnType<typeof vi.fn>;
    hasOpenSpans: () => boolean;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The callbacks the context creator was handed, in order. */
  let received: GatewayHandler[];

  /**
   * Builds the agent over a fresh context creator, and returns what the
   * patched `create` makes of `handler` - and `create` itself, for another.
   *
   * The creator's chain calls the handler as Nest's does: at once without an
   * interceptor, and with one, from a cold stream the chain resolves to,
   * once something subscribes.
   */
  function instrument(
    handler: GatewayHandler,
    chain: "direct" | "intercepted" = "direct",
  ) {
    received = [];
    class WsContextCreator {
      create(instance: object, callback: GatewayHandler, ..._rest: unknown[]) {
        received.push(callback);
        if (chain === "direct") {
          return async (...args: unknown[]) => callback.apply(instance, args);
        }
        return async (...args: unknown[]) =>
          defer(() => {
            const result = callback.apply(instance, args);
            return isObservable(result)
              ? result
              : from(Promise.resolve(result));
          });
      }
    }
    vi.spyOn(
      WsObserveAgentService.prototype as unknown as {
        loadContextCreator: () => unknown;
      },
      "loadContextCreator",
    ).mockReturnValue(WsContextCreator);
    registry = {
      startTrace: vi.fn(),
      endTrace: vi.fn(),
      abandonTrace: vi.fn(),
      pluckSnapshot: vi.fn(async () => undefined),
      hasOpenSpans: () => false,
    };
    // The agent patches the context creator from its constructor.
    void new WsObserveAgentService(
      { insertRequestSnapshot: vi.fn() } as never,
      { traceIdKey: "traceId", ws: {} } as never,
      registry as never,
      { shouldCapture: () => true } as never,
      new AsyncLocalStorage<Map<string, any>>(),
    );
    class Gateway {
      handle(...args: unknown[]) {
        return handler(...args);
      }
    }
    // oxlint-disable-next-line typescript/unbound-method -- applied to the gateway by `create`
    const { handle } = Gateway.prototype;
    Reflect.defineMetadata("message", "orders", handle);
    const gateway = new Gateway();
    const create = () =>
      new WsContextCreator().create(gateway, handle, "module", "handle");
    return Object.assign(create(), { create });
  }

  const tracedIds = () =>
    registry.startTrace.mock.calls.map(([traceId]) => traceId as string);

  it("drops the trace of a message whose socket.io client disconnects before the handler settles", async () => {
    const handle = instrument(() => new Promise(() => undefined));
    const socket = Object.assign(new EventEmitter(), { disconnect() {} });

    void handle(socket, "payload");
    void handle(socket, "payload");
    expect(socket.listenerCount("disconnect")).toBe(1);
    socket.emit("disconnect");

    expect(registry.abandonTrace.mock.calls.map(([id]) => id)).toEqual(
      tracedIds(),
    );
    expect(registry.endTrace).not.toHaveBeenCalled();
  });

  it("drops the trace of a message whose ws client closes, and forgets one that settled first", async () => {
    let answer!: (value: unknown) => void;
    const handle = instrument(
      () => new Promise((resolve) => (answer = resolve)),
    );
    const socket = new EventEmitter();

    const settled = handle(socket, "first");
    answer("done");
    await settled;
    void handle(socket, "second");
    socket.emit("close");

    const [first, second] = tracedIds();
    await vi.waitFor(() =>
      expect(registry.endTrace).toHaveBeenCalledWith(first, expect.anything()),
    );
    expect(registry.abandonTrace.mock.calls).toEqual([[second]]);
  });

  it.each([
    ["a socket.io client that has disconnected", { disconnected: true }],
    ["a ws client that has closed", { readyState: 3 }],
  ])(
    "drops at once the trace of a message from %s, and still runs the handler",
    async (_, state) => {
      const handler = vi.fn(() => "answered");
      const handle = instrument(handler);
      const socket = Object.assign(new EventEmitter(), state);

      await expect(handle(socket, "payload")).resolves.toBe("answered");

      expect(handler).toHaveBeenCalledOnce();
      expect(registry.abandonTrace.mock.calls).toEqual([[tracedIds()[0]]]);
      expect(registry.endTrace).not.toHaveBeenCalled();
    },
  );

  it("traces a message from a client that is no event emitter as before", async () => {
    const handle = instrument(() => "answered");

    await expect(handle({ id: "custom" }, "payload")).resolves.toBe("answered");
    await expect(handle(undefined, "payload")).resolves.toBe("answered");

    await vi.waitFor(() => expect(registry.endTrace).toHaveBeenCalledTimes(2));
    expect(registry.abandonTrace).not.toHaveBeenCalled();
  });

  describe("behind an interceptor", () => {
    it("ends the trace at the chain's first value, not when the chain is handed over", async () => {
      const handle = instrument(() => "answered", "intercepted");

      const chain = (await handle({}, "payload")) as Observable<unknown>;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(registry.endTrace).not.toHaveBeenCalled();

      const values: unknown[] = [];
      chain.subscribe((value) => values.push(value));
      await vi.waitFor(() => expect(registry.endTrace).toHaveBeenCalledOnce());
      expect(values).toEqual(["answered"]);
    });

    it("ends the trace when the handler returns a stream, before the stream emits", async () => {
      const stream = new Subject<string>();
      const handle = instrument(() => stream, "intercepted");

      const chain = (await handle({}, "payload")) as Observable<unknown>;
      const subscription = chain.subscribe();

      await vi.waitFor(() => expect(registry.endTrace).toHaveBeenCalledOnce());
      subscription.unsubscribe();
      expect(registry.abandonTrace).not.toHaveBeenCalled();
    });

    it("drops the trace of a chain torn down before it says anything", async () => {
      const handle = instrument(
        () => new Promise(() => undefined),
        "intercepted",
      );

      const chain = (await handle({}, "payload")) as Observable<unknown>;
      const subscription = chain.subscribe();
      await new Promise((resolve) => setTimeout(resolve, 10));
      subscription.unsubscribe();
      subscription.unsubscribe();

      expect(registry.abandonTrace.mock.calls).toEqual([[tracedIds()[0]]]);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(registry.endTrace).not.toHaveBeenCalled();
    });

    it("drops the trace once when its client leaves and the adapter lets go of the chain", async () => {
      const handle = instrument(
        () => new Promise(() => undefined),
        "intercepted",
      );
      const socket = new EventEmitter();

      const chain = (await handle(socket, "payload")) as Observable<unknown>;
      const subscription = chain.subscribe();
      socket.emit("close");
      subscription.unsubscribe();

      expect(registry.abandonTrace).toHaveBeenCalledOnce();
    });
  });

  it("hands Nest one stand-in per method, carrying its metadata, however often the chain is built", () => {
    const handle = instrument(() => "answered");

    handle.create();
    handle.create();

    const [first, second] = received;
    expect(second).toBe(first);
    expect(Reflect.getMetadata("message", first)).toBe("orders");
    expect(first.name).toBe("handle");
  });
});
