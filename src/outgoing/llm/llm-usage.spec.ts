import {
  llmProviderForHost,
  modelFromRequestBody,
  modelFromUrlPath,
} from "./llm-providers.js";
import {
  JsonUsageReader,
  normalizeUsage,
  SseUsageReader,
  usageFromDocument,
} from "./llm-usage.js";

const bytes = (text: string) => new TextEncoder().encode(text);

/** Feeds `text` to a reader in chunks of `size`, splitting lines and characters. */
function feed(
  reader: { push(chunk: Uint8Array): void },
  text: string,
  size = 7,
) {
  const encoded = bytes(text);
  for (let offset = 0; offset < encoded.byteLength; offset += size) {
    reader.push(encoded.subarray(offset, offset + size));
  }
}

describe("llmProviderForHost", () => {
  it("recognises the providers by host, with or without a port", () => {
    expect(llmProviderForHost("api.openai.com")).toBe("openai");
    expect(llmProviderForHost("api.anthropic.com:443")).toBe("anthropic");
    expect(llmProviderForHost("generativelanguage.googleapis.com")).toBe(
      "google",
    );
    expect(llmProviderForHost("acme-eu.openai.azure.com")).toBe("azure-openai");
    expect(llmProviderForHost("us-central1-aiplatform.googleapis.com")).toBe(
      "vertex",
    );
    expect(llmProviderForHost("bedrock-runtime.eu-west-1.amazonaws.com")).toBe(
      "bedrock",
    );
  });

  it("leaves every other host alone, unless the application names it", () => {
    expect(llmProviderForHost("api.stripe.com")).toBeUndefined();
    expect(llmProviderForHost("openai.com.evil.example")).toBeUndefined();
    for (const inherited of ["constructor", "__proto__", "toString"]) {
      expect(llmProviderForHost(inherited), inherited).toBeUndefined();
    }
    const extra = new Set(["llm-gateway.internal:4000"]);
    expect(llmProviderForHost("llm-gateway.internal:4000", extra)).toBe(
      "custom",
    );
    expect(llmProviderForHost("llm-gateway.internal:5000", extra)).toBe(
      undefined,
    );
  });
});

describe("model from the request", () => {
  it("reads the model field from a JSON body, as a string or as bytes", () => {
    const body = JSON.stringify({ model: "gpt-4.1-mini", messages: [] });
    expect(modelFromRequestBody(body)).toBe("gpt-4.1-mini");
    expect(modelFromRequestBody(bytes(body))).toBe("gpt-4.1-mini");
    expect(modelFromRequestBody(undefined)).toBeUndefined();
    expect(modelFromRequestBody(new FormData())).toBeUndefined();
  });

  // A tool call's input or a tool result is part of the prompt, and may hold
  // a key of the same name: what it says is not the model, and not the
  // agent's to report.
  it("reads only the outermost object's model, never one in the prompt", () => {
    const converse = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { toolResult: { content: [{ json: { model: "secret device" } }] } },
          ],
        },
      ],
    });
    expect(modelFromRequestBody(converse)).toBeUndefined();
    expect(
      modelFromRequestBody(
        JSON.stringify({
          messages: [{ role: "user", content: { model: "secret" } }],
          system: "a } that closes nothing, a { that opens nothing",
          model: "claude-sonnet-4-5",
        }),
      ),
    ).toBe("claude-sonnet-4-5");
    expect(
      modelFromRequestBody(
        JSON.stringify({ prompt: '"model":"secret"', model: "gpt-4.1" }),
      ),
    ).toBe("gpt-4.1");
    expect(modelFromRequestBody('say "model": "secret"')).toBeUndefined();
    expect(
      modelFromRequestBody(JSON.stringify({ model: 4, input: { model: "x" } })),
    ).toBeUndefined();
  });

  it("reads the model out of the path for Gemini, Vertex and Bedrock", () => {
    expect(
      modelFromUrlPath("/v1beta/models/gemini-2.5-flash:streamGenerateContent"),
    ).toBe("gemini-2.5-flash");
    expect(
      modelFromUrlPath(
        "/model/anthropic.claude-sonnet-4-20250514-v1%3A0/converse",
      ),
    ).toBe("anthropic.claude-sonnet-4-20250514-v1:0");
    expect(modelFromUrlPath("/v1/chat/completions")).toBeUndefined();
  });
});

describe("normalizeUsage", () => {
  it("counts OpenAI's cached tokens inside the input", () => {
    expect(
      normalizeUsage({
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
  });

  it("adds Anthropic's cache reads and writes to its input", () => {
    expect(
      normalizeUsage({
        input_tokens: 10,
        cache_read_input_tokens: 90,
        cache_creation_input_tokens: 5,
        output_tokens: 7,
      }),
    ).toEqual({ inputTokens: 105, outputTokens: 7, cachedInputTokens: 90 });
  });

  it("reads Gemini, the Responses API, Bedrock and Cohere spellings", () => {
    expect(
      normalizeUsage({
        promptTokenCount: 12,
        candidatesTokenCount: 30,
        thoughtsTokenCount: 8,
        cachedContentTokenCount: 4,
      }),
    ).toEqual({ inputTokens: 12, outputTokens: 38, cachedInputTokens: 4 });
    expect(
      normalizeUsage({
        input_tokens: 50,
        output_tokens: 9,
        input_tokens_details: { cached_tokens: 10 },
      }),
    ).toEqual({ inputTokens: 50, outputTokens: 9, cachedInputTokens: 10 });
    expect(normalizeUsage({ inputTokens: 5, outputTokens: 6 })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    });
    expect(
      normalizeUsage({ billed_units: { input_tokens: 3, output_tokens: 4 } }),
    ).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("ignores what is not a count", () => {
    expect(normalizeUsage(null)).toEqual({});
    expect(
      normalizeUsage({ prompt_tokens: -1, completion_tokens: "12" }),
    ).toEqual({});
  });
});

describe("JsonUsageReader", () => {
  it("reads usage and model from a response arriving in pieces", () => {
    const reader = new JsonUsageReader();
    feed(
      reader,
      JSON.stringify({
        id: "chatcmpl-1",
        model: "gpt-4o-2024-08-06",
        choices: [{ message: { content: "hello" } }],
        usage: { prompt_tokens: 11, completion_tokens: 2 },
      }),
    );
    expect(reader.finish()).toEqual({
      model: "gpt-4o-2024-08-06",
      inputTokens: 11,
      outputTokens: 2,
    });
  });

  it("matches usage out of the ends of a body too large to keep", () => {
    const reader = new JsonUsageReader();
    const content = "x".repeat(3 * 1024 * 1024);
    feed(
      reader,
      JSON.stringify({
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: content }],
        usage: { input_tokens: 900, output_tokens: 64000 },
      }),
      256 * 1024,
    );
    expect(reader.finish()).toEqual({
      model: "claude-sonnet-4-5",
      inputTokens: 900,
      outputTokens: 64000,
    });
  });

  it("takes the model of a body too large to keep from its outermost object only", () => {
    const reader = new JsonUsageReader();
    feed(
      reader,
      JSON.stringify({
        output: [
          { type: "function_call", arguments: { model: "secret text" } },
          { type: "message", text: "x".repeat(3 * 1024 * 1024) },
        ],
        usage: { input_tokens: 5, output_tokens: 6 },
      }),
      256 * 1024,
    );
    expect(reader.finish()).toEqual({ inputTokens: 5, outputTokens: 6 });
  });

  it("gives up quietly on a body that is not JSON", () => {
    const reader = new JsonUsageReader();
    feed(reader, "<html>bad gateway</html>");
    expect(reader.finish()).toEqual({});
  });

  // A chunk kept as it was handed over costs a few hundred bytes of heap on
  // top of its own: a body a byte at a time would be held a hundred times
  // over. What the reader keeps are copies, bounded by the bytes counted.
  it.each([
    ["one byte at a time", 1],
    ["in pieces", 7],
  ])("keeps a copy of a body arriving %s, not the chunks", (_name, size) => {
    const reader = new JsonUsageReader();
    const encoded = bytes(
      JSON.stringify({
        model: "gpt-4o-2024-08-06",
        choices: [{ message: { content: "hello é ✓" } }],
        usage: { prompt_tokens: 11, completion_tokens: 2 },
      }),
    );
    for (let offset = 0; offset < encoded.byteLength; offset += size) {
      const chunk = encoded.slice(offset, offset + size);
      reader.push(chunk);
      chunk.fill(0);
    }
    expect(reader.finish()).toEqual({
      model: "gpt-4o-2024-08-06",
      inputTokens: 11,
      outputTokens: 2,
    });
  });
});

describe("SseUsageReader", () => {
  it("reads an OpenAI chat stream's final usage chunk", () => {
    let clock = 100;
    const reader = new SseUsageReader(() => clock);
    feed(
      reader,
      [
        `data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"Hi"}}],"usage":null}`,
        ``,
        `data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":" there"}}],"usage":null}`,
        ``,
        `data: {"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":21,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":0}}}`,
        ``,
        `data: [DONE]`,
        ``,
      ].join("\n"),
    );
    clock = 500;
    expect(reader.finish()).toEqual({
      model: "gpt-4o-mini",
      inputTokens: 21,
      outputTokens: 2,
      cachedInputTokens: 0,
    });
    expect(reader.firstEventAt).toBe(100);
  });

  it("puts Anthropic's message_start and message_delta together", () => {
    const reader = new SseUsageReader();
    feed(
      reader,
      [
        `event: message_start`,
        `data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":12,"cache_read_input_tokens":300,"output_tokens":1}}}`,
        ``,
        `event: content_block_delta`,
        `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}`,
        ``,
        `event: message_delta`,
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":48}}`,
        ``,
      ].join("\r\n"),
      5,
    );
    expect(reader.finish()).toEqual({
      model: "claude-haiku-4-5",
      inputTokens: 312,
      outputTokens: 48,
      cachedInputTokens: 300,
    });
  });

  it("reads the Responses API's completed event and Gemini's usage metadata", () => {
    const responses = new SseUsageReader();
    feed(
      responses,
      [
        `event: response.created`,
        `data: {"type":"response.created","response":{"model":"gpt-5-mini","usage":null}}`,
        ``,
        `event: response.output_text.delta`,
        `data: {"type":"response.output_text.delta","delta":"ok"}`,
        ``,
        `event: response.completed`,
        `data: {"type":"response.completed","response":{"model":"gpt-5-mini","usage":{"input_tokens":40,"output_tokens":3,"input_tokens_details":{"cached_tokens":16}}}}`,
        ``,
      ].join("\n"),
    );
    expect(responses.finish()).toEqual({
      model: "gpt-5-mini",
      inputTokens: 40,
      outputTokens: 3,
      cachedInputTokens: 16,
    });

    const gemini = new SseUsageReader();
    feed(
      gemini,
      [
        `data: {"candidates":[{"content":{"parts":[{"text":"A"}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":1},"modelVersion":"gemini-2.5-flash"}`,
        ``,
        `data: {"candidates":[{"content":{"parts":[{"text":"B"}]}}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":14},"modelVersion":"gemini-2.5-flash"}`,
        ``,
      ].join("\n"),
    );
    expect(gemini.finish()).toEqual({
      model: "gemini-2.5-flash",
      inputTokens: 9,
      outputTokens: 14,
    });
  });

  it("skips an oversized line without losing the events around it", () => {
    const reader = new SseUsageReader();
    feed(
      reader,
      [
        `data: {"model":"m1"}`,
        ``,
        `data: {"text":"${"y".repeat(1100 * 1024)}"}`,
        ``,
        `data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}`,
        ``,
      ].join("\n"),
      64 * 1024,
    );
    expect(reader.finish()).toEqual({
      model: "m1",
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it("reads a stream arriving one byte at a time, characters split and all", () => {
    const reader = new SseUsageReader();
    feed(
      reader,
      [
        `data: {"model":"modèle-✓","text":"héllo"}`,
        ``,
        `data: {"text":"wörld ✓"}\r`,
        ``,
        `data: {"usage":{"prompt_tokens":3,"completion_tokens":4}}`,
      ].join("\n"),
      1,
    );
    expect(reader.finish()).toEqual({
      model: "modèle-✓",
      inputTokens: 3,
      outputTokens: 4,
    });
  });
});

describe("usageFromDocument", () => {
  it("reads a whole Anthropic message", () => {
    expect(
      usageFromDocument({
        type: "message",
        model: "claude-opus-4-1",
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    ).toEqual({ model: "claude-opus-4-1", inputTokens: 7, outputTokens: 3 });
  });
});
