import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { subscribeOutgoingHttp } from "./http.integration.js";
import { OutgoingSpanRecorder } from "./outgoing-span.recorder.js";

/**
 * The `node:http` client's own channels, published by hand: `created` fires
 * in the call that makes the request, `start` once the request is ended -
 * for a piped body, from the source's `end` event, in another context.
 * Published by hand so the order and the contexts are the test's, whatever
 * Node this runs on.
 */
describe("node:http requests", () => {
  const caller = new AsyncLocalStorage<string>();
  let opened: Array<{ name: string; traceId: string | undefined }>;
  let unsubscribe: () => void;

  beforeEach(() => {
    opened = [];
    const recorder = {
      open: (_kind: string, name: string) => {
        opened.push({ name, traceId: caller.getStore() });
        return { spanId: "span", end: () => undefined };
      },
      isRecording: () => true,
    } as unknown as OutgoingSpanRecorder;
    unsubscribe = subscribeOutgoingHttp(recorder, () => {
      const traceId = caller.getStore();
      return traceId === undefined ? undefined : { traceId };
    });
  });

  afterEach(() => unsubscribe());

  const nodeRequest = (path: string) => {
    const headers = new Map<string, string>();
    return {
      method: "PUT",
      protocol: "http:",
      host: "storage.internal",
      path,
      headers,
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string) => headers.set(name, value),
      once: () => undefined,
    };
  };
  const publish = (name: string, request: object) =>
    channel(`http.client.request.${name}`).publish({ request });

  it("opens the span in the trace that created the request", () => {
    const request = nodeRequest("/victim.bin");

    caller.run("victim-copy", () => publish("created", request));
    // The body piped in ends in the context of whoever opened its source.
    caller.run("attacker-copy", () => publish("start", request));

    expect(request.headers.get("x-request-id")).toBe("victim-copy");
    expect(opened).toEqual([
      { name: "PUT storage.internal", traceId: "victim-copy" },
    ]);
  });

  it("opens no span in another trace for a request created outside one", () => {
    const request = nodeRequest("/startup.bin");

    publish("created", request);
    caller.run("someone-else", () => publish("start", request));

    expect(opened).toEqual([
      { name: "PUT storage.internal", traceId: undefined },
    ]);
  });

  it("opens the span where it starts when it was never seen created", () => {
    // Node before 22.12 publishes no `created`.
    const request = nodeRequest("/old-node.bin");

    caller.run("only-trace", () => publish("start", request));

    expect(opened).toEqual([
      { name: "PUT storage.internal", traceId: "only-trace" },
    ]);
  });
});
