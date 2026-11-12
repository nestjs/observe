import { AsyncLocalStorage } from "async_hooks";
import { EventEmitter } from "events";
import { WsObserveAgentService } from "./ws-observe-agent.service.js";

type GatewayHandler = (...args: unknown[]) => unknown;

/**
 * The agent's side of a gateway message, against a stand-in for Nest's
 * `WsContextCreator` and a registry that only records what it is told. The
 * adapters themselves are exercised by the ws int-specs; these are the cases a
 * running gateway does not produce on demand - a client that is gone before
 * its message is traced, one that is no event emitter.
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

  /**
   * Builds the agent over a fresh context creator whose `create` calls the
   * handler as Nest's does for a handler without interceptors, and returns
   * what the patched `create` makes of `handler`.
   */
  function instrument(handler: GatewayHandler): GatewayHandler {
    class WsContextCreator {
      create(instance: object, callback: GatewayHandler, ..._rest: unknown[]) {
        return async (...args: unknown[]) => callback.apply(instance, args);
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
    const gateway = new Gateway();
    return new WsContextCreator().create(
      gateway,
      // oxlint-disable-next-line typescript/unbound-method -- applied to the gateway by `create`
      Gateway.prototype.handle,
      "module",
      "handle",
    );
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
});
