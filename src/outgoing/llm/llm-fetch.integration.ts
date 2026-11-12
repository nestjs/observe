import { AsyncLocalStorage } from "async_hooks";
import type { ObserveOptions } from "../../interfaces/observe-options.interface.js";
import {
  OpenOutgoingSpan,
  OutgoingSpanRecorder,
} from "../outgoing-span.recorder.js";
import {
  llmProviderForHost,
  modelFromRequestBody,
  modelFromUrlPath,
} from "./llm-providers.js";
import {
  JsonUsageReader,
  LlmUsage,
  mergeUsage,
  SseUsageReader,
} from "./llm-usage.js";

export interface OutgoingLlmOptions {
  /**
   * More hosts to read as model providers - a gateway in front of them, a
   * self-hosted model with an OpenAI-compatible API - as `host` or
   * `host:port`. Their calls are tagged with the provider `custom`.
   * @example ['llm-gateway.internal:4000']
   */
  hosts?: string[];
}

/**
 * What one observed `fetch` call learns from the outbound span undici opens
 * for it: the span, held open until the response has been read.
 */
interface LlmFetchHolder {
  span?: OpenOutgoingSpan;
  release?: () => void;
}

/**
 * Carries a holder from the `fetch` call into undici's request-create channel,
 * which runs inside the call's async context. That is how the span the HTTP
 * integration opens is found again here, without a header or a lookup table.
 */
export const llmFetchContext = new AsyncLocalStorage<LlmFetchHolder>();

/** Called by the HTTP integration for every span it opens. */
export function attachLlmSpan(span: OpenOutgoingSpan | undefined): void {
  const holder = llmFetchContext.getStore();
  if (!holder || !span || holder.span) {
    return;
  }
  holder.span = span;
  // Taken now, before undici can end the span: a small response can arrive
  // whole, and end its span, before the caller's `await` sees it.
  holder.release = span.hold?.();
}

interface LlmObserverConfig {
  recorder: OutgoingSpanRecorder;
  extraHosts: ReadonlySet<string>;
}

const INSTALLED = Symbol.for("@nestjs/observe:llm-fetch");

let active: LlmObserverConfig | undefined;

/** The wrapper this copy of the module put in place, and what it wraps. */
let installed: { wrapper: typeof fetch; original: typeof fetch } | undefined;

/**
 * Whether an `outgoing` option turns model calls off. They are read off the
 * HTTP spans, so turning those off turns model calls off with them.
 */
export function llmCallsOff(outgoing: ObserveOptions["outgoing"]): boolean {
  return (
    outgoing === false || outgoing?.http === false || outgoing?.llm === false
  );
}

/**
 * Wraps the global `fetch` once, inert until `activateLlmFetchObserver`.
 *
 * Wrapped as early as the module is created rather than when the agent
 * starts: a client that captures `fetch` when it is constructed - the
 * official OpenAI and Anthropic SDKs do - and is constructed before Nest
 * instantiates the agent would otherwise keep the unwrapped one. Calls to
 * any other host go straight to the original. An application that turns
 * model calls off gets the original back - see `uninstallLlmFetchObserver`.
 */
export function installLlmFetchObserver(): void {
  const original = globalThis.fetch as
    | (typeof fetch & { [INSTALLED]?: true })
    | undefined;
  if (typeof original !== "function" || original[INSTALLED]) {
    return;
  }
  const observed = function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const config = active;
    if (!config) {
      return original(input, init);
    }
    let target: URL;
    try {
      target =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
    } catch {
      return original(input, init);
    }
    const provider = llmProviderForHost(target.host, config.extraHosts);
    // Outside a traced operation there is no span to tag.
    if (!provider || !config.recorder.isRecording()) {
      return original(input, init);
    }
    return observeCall(original, input, init, {
      provider,
      requestModel:
        modelFromRequestBody(init?.body) ?? modelFromUrlPath(target.pathname),
    });
  };
  Object.defineProperty(observed, INSTALLED, { value: true });
  globalThis.fetch = observed;
  installed = { wrapper: observed, original };
}

/**
 * Puts the original `fetch` back, for an application that turned model calls
 * off: with them off, nothing of this should sit in its calls' path.
 *
 * Only while the wrapper is still the global one. Something that wrapped
 * `fetch` again on top of it would be unwrapped too, so in that case the
 * wrapper stays where it is, inert - a straight pass-through.
 */
export function uninstallLlmFetchObserver(): void {
  active = undefined;
  if (installed && globalThis.fetch === installed.wrapper) {
    globalThis.fetch = installed.original;
    installed = undefined;
  }
}

/** Starts reading model calls; the returned function stops it again. */
export function activateLlmFetchObserver(
  recorder: OutgoingSpanRecorder,
  options: OutgoingLlmOptions = {},
): () => void {
  installLlmFetchObserver();
  const config: LlmObserverConfig = {
    recorder,
    extraHosts: new Set(
      (options.hosts ?? []).map((host) => host.toLowerCase()),
    ),
  };
  active = config;
  return () => {
    if (active === config) {
      active = undefined;
    }
  };
}

interface CallContext {
  provider: string;
  requestModel: string | undefined;
}

/**
 * Cancels a provider's stream once the stream handed to the caller in its
 * place can no longer be read. undici does this for an unread response it
 * created, but not for one whose body is locked, as the provider's is once
 * it is read through here: a reply the application drops would otherwise
 * hold its socket, its buffered body and its span for good.
 */
const abandonedBodies = new FinalizationRegistry<() => void>((release) => {
  try {
    release();
  } catch {
    /* thrown from here it would be an uncaught exception in the host */
  }
});

async function observeCall(
  original: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  call: CallContext,
): Promise<Response> {
  const startedAt = performance.now();
  const holder: LlmFetchHolder = {};
  const tag = (usage: LlmUsage, stream: boolean, firstEventAt?: number) => {
    try {
      holder.span?.tag?.(
        spanTags(call, mergeUsage({ model: call.requestModel }, usage), {
          stream,
          timeToFirstToken:
            firstEventAt === undefined
              ? undefined
              : round(firstEventAt - startedAt),
        }),
      );
    } catch {
      /* a lost tag must never cost the caller its response */
    } finally {
      holder.release?.();
    }
  };

  let response: Response;
  try {
    response = await llmFetchContext.run(holder, () => original(input, init));
  } catch (error) {
    tag({}, false);
    throw error;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const stream = contentType.includes("text/event-stream");
  const reader = stream
    ? new SseUsageReader()
    : contentType.includes("json")
      ? new JsonUsageReader()
      : undefined;
  // No span was opened for it (an outer entry point covers the call), or
  // there is nothing to read: the response goes back untouched.
  if (!holder.span || !reader || !response.body) {
    tag({}, stream);
    return response;
  }

  let tagged = false;
  const finish = () => {
    if (tagged) {
      return;
    }
    tagged = true;
    // Read to its end, failed or cancelled: nothing is left to release.
    abandonedBodies.unregister(holder);
    let usage: LlmUsage = {};
    try {
      usage = reader.finish();
    } catch {
      /* unreadable: tag the call without its usage */
    }
    tag(
      usage,
      stream,
      reader instanceof SseUsageReader ? reader.firstEventAt : undefined,
    );
  };

  // Read only as the caller reads, and cancelled when the caller cancels: a
  // tee would keep pulling a stream the caller abandoned, and the model would
  // go on generating - and billing - a completion nobody reads.
  const source = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let chunk: Awaited<ReturnType<typeof source.read>>;
        try {
          chunk = await source.read();
        } catch (error) {
          finish();
          controller.error(error);
          return;
        }
        if (chunk.done) {
          finish();
          controller.close();
          return;
        }
        try {
          reader.push(chunk.value);
        } catch {
          /* the bytes still reach the caller */
        }
        controller.enqueue(chunk.value);
      },
      cancel(reason) {
        finish();
        return source.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  // Watching `body`, not the response: a caller that keeps only the body,
  // or a clone, can still read it. Nothing registered may reach `body`, or
  // it would never be collected.
  abandonedBodies.register(
    body,
    () => {
      try {
        finish();
      } finally {
        source
          .cancel("Response object has been garbage collected")
          .catch(() => undefined);
      }
    },
    holder,
  );
  return rewrap(response, body);
}

/** The same response, reading through `body`. */
function rewrap(
  response: Response,
  body: ReadableStream<Uint8Array>,
): Response {
  const wrapped = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  // Read-only getters on a constructed response; the original's values are
  // what the caller would have seen.
  Object.defineProperties(wrapped, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type },
  });
  return wrapped;
}

/** The call, as tags on its outbound span - what the waterfall shows. */
function spanTags(
  call: CallContext,
  usage: LlmUsage,
  extra: { stream: boolean; timeToFirstToken: number | undefined },
): Record<string, string | number | boolean> {
  return {
    "llm.provider": call.provider,
    // A path-borne Bedrock model id can run long; tags are not the place.
    ...(usage.model ? { "llm.model": usage.model.slice(0, 128) } : {}),
    ...(usage.inputTokens !== undefined
      ? { "llm.input_tokens": usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { "llm.output_tokens": usage.outputTokens }
      : {}),
    ...(usage.cachedInputTokens !== undefined
      ? { "llm.cached_input_tokens": usage.cachedInputTokens }
      : {}),
    ...(extra.stream ? { "llm.stream": true } : {}),
    ...(extra.timeToFirstToken !== undefined
      ? { "llm.time_to_first_token_ms": extra.timeToFirstToken }
      : {}),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
