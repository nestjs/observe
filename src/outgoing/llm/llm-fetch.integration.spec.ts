import { AsyncLocalStorage } from "async_hooks";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createObserveModule } from "../../observe.module.js";
import { OperationTraceRegistry } from "../../services/operation-trace.registry.js";
import { testObserveOptions } from "../../testing/observe-harness.js";
import { OutgoingObserveAgentService } from "../outgoing-observe-agent.service.js";
import {
  activateLlmFetchObserver,
  attachLlmSpan,
  installLlmFetchObserver,
  llmCallsOff,
  uninstallLlmFetchObserver,
} from "./llm-fetch.integration.js";

// Each test starts from a plain `fetch` of its own, so what the module does to
// the global is visible, and the real one comes back afterwards.
const realFetch = globalThis.fetch;
let plain: typeof fetch;

beforeEach(() => {
  plain = vi.fn(async () => new Response("ok"));
  globalThis.fetch = plain;
});

afterEach(() => {
  uninstallLlmFetchObserver();
  globalThis.fetch = realFetch;
});

describe("a model reply the application drops", () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;

  /** A provider reply that never ends, and remembers being cancelled. */
  const provider = (cancelled: unknown[], released: () => void) => {
    globalThis.fetch = async () => {
      attachLlmSpan({
        spanId: "1",
        end: () => undefined,
        hold: () => released,
      });
      return new Response(
        new ReadableStream(
          {
            pull: (controller) => controller.enqueue(bytes("{")),
            cancel: (reason) => void cancelled.push(reason),
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "application/json" } },
      );
    };
    installLlmFetchObserver();
    return activateLlmFetchObserver({ isRecording: () => true } as never);
  };

  const collect = async (until: () => boolean) => {
    for (let attempt = 0; attempt < 20 && !until(); attempt++) {
      gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const bytes = (text: string) => new TextEncoder().encode(text);
  const url = "https://api.openai.com/v1/chat/completions";

  it("cancels the provider's stream once nothing can read it any more", async () => {
    const cancelled: unknown[] = [];
    const released = vi.fn();
    const stop = provider(cancelled, released);
    try {
      // Read a little, then dropped: an abandoned stream, a lost race.
      await (async () => {
        const response = await globalThis.fetch(url, { body: "{}" });
        await response.body!.getReader().read();
      })();
      await collect(() => cancelled.length > 0);
    } finally {
      stop();
    }
    expect(cancelled).toHaveLength(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("leaves a stream the caller still holds alone", async () => {
    const cancelled: unknown[] = [];
    const stop = provider(cancelled, vi.fn());
    try {
      const response = await globalThis.fetch(url, { body: "{}" });
      const body = response.body!;
      await collect(() => false);
      expect(cancelled).toEqual([]);
      await body.cancel("done");
      expect(cancelled).toEqual(["done"]);
    } finally {
      stop();
    }
  });
});

describe("llmCallsOff", () => {
  it("is on unless outgoing, http or llm is false", () => {
    expect(llmCallsOff(undefined)).toBe(false);
    expect(llmCallsOff({})).toBe(false);
    expect(llmCallsOff({ llm: { hosts: ["llm-gateway:4000"] } })).toBe(false);
    expect(llmCallsOff(false)).toBe(true);
    expect(llmCallsOff({ http: false })).toBe(true);
    expect(llmCallsOff({ llm: false })).toBe(true);
  });
});

describe("the fetch wrapper", () => {
  it("puts the original fetch back when it is uninstalled", () => {
    installLlmFetchObserver();
    expect(globalThis.fetch).not.toBe(plain);

    uninstallLlmFetchObserver();
    expect(globalThis.fetch).toBe(plain);
  });

  it("stays, as a pass-through, under a fetch wrapped on top of it", async () => {
    installLlmFetchObserver();
    const wrapper = globalThis.fetch;
    const outer = (...args: Parameters<typeof fetch>) => wrapper(...args);
    globalThis.fetch = outer;

    // Unwrapping here would take `outer` out of the chain too.
    uninstallLlmFetchObserver();
    expect(globalThis.fetch).toBe(outer);

    await globalThis.fetch("https://api.openai.com/v1/models");
    expect(plain).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      undefined,
    );
  });

  it("is given back by forRoot options that turn model calls off", () => {
    const { ObserveModule } = createObserveModule();
    expect(globalThis.fetch).not.toBe(plain);

    ObserveModule.forRoot(testObserveOptions({ outgoing: { llm: false } }));
    expect(globalThis.fetch).toBe(plain);

    ObserveModule.forRoot(testObserveOptions({ outgoing: { http: false } }));
    expect(globalThis.fetch).toBe(plain);

    // And put back in place by options that turn them on again.
    ObserveModule.forRoot(testObserveOptions());
    expect(globalThis.fetch).not.toBe(plain);
  });

  it("is given back when the agent starts with model calls off, for forRootAsync", () => {
    installLlmFetchObserver();
    const asyncLocalStorage = new AsyncLocalStorage<Map<any, any>>();
    const agent = new OutgoingObserveAgentService(
      {
        ...testObserveOptions({ outgoing: { database: false, llm: false } }),
        traceIdKey: "traceId",
      } as never,
      new OperationTraceRegistry(asyncLocalStorage as never),
      asyncLocalStorage,
    );
    try {
      expect(globalThis.fetch).toBe(plain);
    } finally {
      agent.onApplicationShutdown();
    }
  });
});
