/**
 * Model providers the agent recognises by host, and how to read which model a
 * call asked for before its response says.
 *
 * Recognised by host rather than by SDK: the official clients, the Vercel AI
 * SDK, LangChain and a hand-written `fetch` all end in the same request to the
 * same host, so a host list covers every client without knowing any of them.
 */

/**
 * Exact hosts, each with the provider name the dashboard groups by. A `Map`,
 * not an object literal: looked up by the host of any outgoing call, and a
 * host spelt `constructor` or `__proto__` found an inherited member there.
 */
const EXACT_HOSTS: ReadonlyMap<string, string> = new Map([
  ["api.openai.com", "openai"],
  ["api.anthropic.com", "anthropic"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.mistral.ai", "mistral"],
  ["api.groq.com", "groq"],
  ["openrouter.ai", "openrouter"],
  ["api.together.xyz", "together"],
  ["api.deepseek.com", "deepseek"],
  ["api.x.ai", "xai"],
  ["api.cohere.ai", "cohere"],
  ["api.cohere.com", "cohere"],
  ["api.perplexity.ai", "perplexity"],
]);

/** Hosts that carry a tenant or a region in a subdomain. */
const HOST_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/^[a-z0-9-]+\.openai\.azure\.com$/, "azure-openai"],
  [/^[a-z0-9-]+\.services\.ai\.azure\.com$/, "azure-openai"],
  [/^[a-z0-9-]+-aiplatform\.googleapis\.com$/, "vertex"],
  [/^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/, "bedrock"],
];

/** The provider a call to `host` goes to, or undefined when it is not one. */
export function llmProviderForHost(
  host: string,
  extraHosts: ReadonlySet<string> = new Set(),
): string | undefined {
  const normalized = host.toLowerCase();
  const hostname = normalized.replace(/:\d+$/, "");
  const exact = EXACT_HOSTS.get(hostname);
  if (exact) {
    return exact;
  }
  for (const [pattern, provider] of HOST_PATTERNS) {
    if (pattern.test(hostname)) {
      return provider;
    }
  }
  if (extraHosts.has(normalized) || extraHosts.has(hostname)) {
    return "custom";
  }
  return undefined;
}

/** Most of a request body read for its `model` field. Prompts can be megabytes. */
const MODEL_SCAN_BYTES = 64 * 1024;

/** What follows a `"model"` key: the value, when it is a short string. */
const MODEL_VALUE = /\s*:\s*"([^"\\]{1,128})"/y;

/**
 * The `model` of the outermost object of a JSON document, or of as much of
 * one as `text` holds - and nothing for text that does not open with `{`.
 *
 * A scan rather than `JSON.parse`, which a cut-off document would fail, and
 * rather than a search for `"model":`, which finds that key at any depth: a
 * tool call's input, a tool result or a JSON-mode completion can carry one,
 * and what it holds is the prompt's, not the model's. Strings are skipped
 * whole, so a brace or a key inside one counts for nothing. Linear, and done
 * at the first `model` key of the outermost object - where clients put it.
 */
export function topLevelModel(text: string): string | undefined {
  let index = text.search(/\S/);
  if (index === -1 || text[index] !== "{") {
    return undefined;
  }
  let depth = 0;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) {
        if (text[index] === "\\") {
          index++;
        }
      }
      if (
        depth === 1 &&
        index - start === 6 &&
        text.startsWith('"model"', start)
      ) {
        MODEL_VALUE.lastIndex = index + 1;
        const value = MODEL_VALUE.exec(text);
        if (value) {
          return value[1];
        }
      }
    } else if (char === "{" || char === "[") {
      depth++;
    } else if ((char === "}" || char === "]") && --depth === 0) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The model a JSON request body names, read from its first 64 KB.
 *
 * Read with `topLevelModel`: the body is the application's prompt, often far
 * larger than the one field wanted, and every client puts `model` near the
 * top. Bodies that are streams or forms are not read at all - reading them
 * would consume what the request is about to send.
 */
export function modelFromRequestBody(body: unknown): string | undefined {
  let text: string | undefined;
  if (typeof body === "string") {
    text = body.slice(0, MODEL_SCAN_BYTES);
  } else if (body instanceof Uint8Array) {
    text = new TextDecoder().decode(body.subarray(0, MODEL_SCAN_BYTES));
  } else if (body instanceof ArrayBuffer) {
    text = new TextDecoder().decode(
      new Uint8Array(body, 0, Math.min(body.byteLength, MODEL_SCAN_BYTES)),
    );
  }
  return text ? topLevelModel(text) : undefined;
}

/**
 * The model a URL names, for the providers that put it in the path rather
 * than the body: Gemini and Vertex (`.../models/gemini-2.5-flash:generateContent`)
 * and Bedrock (`/model/anthropic.claude-sonnet-4-v1:0/converse`).
 */
export function modelFromUrlPath(pathname: string): string | undefined {
  const google = /\/models\/([^/:]+):/.exec(pathname);
  if (google) {
    return safeDecode(google[1]);
  }
  const bedrock = /\/model\/([^/]+)\/(?:invoke|converse)/.exec(pathname);
  if (bedrock) {
    return safeDecode(bedrock[1]);
  }
  return undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
