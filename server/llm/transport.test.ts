import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { chatBodyExtrasFor } from "./backends";
import { toModelMessages, toToolSet, type LoopToolCall } from "./transport";

/**
 * The conversion boundary, plus the one SDK behavior the whole normalization
 * layer rests on: that `providerOptions` carries a backend's vendor fields all
 * the way into the request body.
 *
 * That last one is asserted against the real provider with a stub `fetch`
 * rather than trusted from the docs — the provider's typed-options schema is
 * `$strip`, which reads as though it would discard exactly these fields, and
 * reading the declaration instead of the behavior got it wrong once already.
 */

/** A provider wired to a fetch that records the outgoing body and answers minimally. */
function providerCapturing(captured: { body?: Record<string, unknown> }) {
  return createOpenAICompatible({
    name: "llm",
    baseURL: "https://inference.invalid/v1",
    fetch: (async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
}

describe("providerOptions carries vendor fields into the request body", () => {
  it("sends the value measured to actually stop Ollama thinking", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await generateText({
      model: providerCapturing(captured).chatModel("m"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
      providerOptions: { llm: chatBodyExtrasFor("ollama", { reasoning: "off" }) },
    });
    expect(captured.body?.reasoning_effort).toBe("none");
  });

  it("sends llama.cpp's nested chat_template_kwargs intact", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await generateText({
      model: providerCapturing(captured).chatModel("m"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
      providerOptions: { llm: chatBodyExtrasFor("llamacpp", { reasoning: "off" }) },
    });
    expect(captured.body?.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(captured.body?.reasoning_format).toBe("none");
  });

  it("adds nothing to the body when the intent expresses no preference", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await generateText({
      model: providerCapturing(captured).chatModel("m"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
    });
    expect(captured.body).not.toHaveProperty("think");
    expect(captured.body).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends Anthropic's thinking switch through the native provider, keyed under its name", async () => {
    // The native provider reads `providerOptions.anthropic`, not the shared
    // `llm` key — which is why the transport resolves the key per connection.
    const captured: { body?: Record<string, unknown>; headers?: Headers } = {};
    const anthropic = createAnthropic({
      apiKey: "sk-ant-key",
      baseURL: "https://anthropic.invalid/v1",
      fetch: (async (_url: string, init?: RequestInit) => {
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        captured.headers = new Headers(init?.headers);
        return new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "m",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    await generateText({
      model: anthropic.languageModel("m"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
      providerOptions: { anthropic: chatBodyExtrasFor("anthropic", { reasoning: "off" }) },
    });

    expect(captured.body?.thinking).toEqual({ type: "disabled" });
    // Native auth rides x-api-key; a Bearer API key is what 401'd the probe.
    expect(captured.headers?.get("x-api-key")).toBe("sk-ant-key");
    expect(captured.headers?.get("anthropic-version")).toBeTruthy();
  });
});

describe("toModelMessages", () => {
  it("keeps a tool round's call/result pairing, which the next round depends on", () => {
    const conversation: ChatCompletionMessageParam[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "what is on that page" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "browse_web", arguments: '{"url":"https://example.invalid"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "the page said hello" },
    ];

    const [, , assistant, toolResult] = toModelMessages(conversation);

    expect(assistant).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "browse_web",
          input: { url: "https://example.invalid" },
        },
      ],
    });
    expect(toolResult).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          // Resolved from the call above — a tool result that cannot name its
          // call is rejected by strict backends.
          toolName: "browse_web",
          output: { type: "text", value: "the page said hello" },
        },
      ],
    });
  });

  /**
   * The SDK rejects `system` turns inside `messages` unless told otherwise, and
   * every reply this app sends interleaves them — the time context after the
   * history window, the language directive last. Nothing mocked catches it: the
   * failure is inside `generateText`, so it needs a real provider call.
   *
   * It shipped once. Every reply would have failed with
   * `AI_InvalidPromptError` on deploy.
   */
  it("accepts system turns positioned between other turns", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await generateText({
      model: providerCapturing(captured).chatModel("m"),
      messages: toModelMessages([
        { role: "system", content: "be nice" },
        { role: "user", content: "earlier" },
        { role: "assistant", content: "earlier answer" },
        { role: "system", content: "It is now 14:00." },
        { role: "system", content: "Reply in English." },
        { role: "user", content: "now" },
      ]),
      allowSystemInMessages: true,
      maxRetries: 0,
    });
    const sent = captured.body?.messages as Array<{ role: string; content: string }>;
    // Order is the point: a system turn collapsed into a leading block would
    // stop outranking the history it was placed after.
    expect(sent.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "system",
      "system",
      "user",
    ]);
    expect(sent.at(-2)?.content).toBe("Reply in English.");
  });

  it("carries a vision turn's image through as an image part", () => {
    const [message] = toModelMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "https://img.invalid/a.jpg" } },
        ],
      } as ChatCompletionMessageParam,
    ]);
    expect(message).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", image: new URL("https://img.invalid/a.jpg") },
      ],
    });
  });

  it("survives malformed tool arguments instead of throwing mid-round", () => {
    const [assistant] = toModelMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c", type: "function", function: { name: "t", arguments: "{not json" } },
        ],
      } as ChatCompletionMessageParam,
    ]);
    expect(assistant).toMatchObject({ content: [{ type: "tool-call", input: {} }] });
  });

  it("hands a signed tool call's thought signature back the way the provider reads it", () => {
    const signed: LoopToolCall[] = [
      {
        id: "c",
        type: "function",
        function: { name: "memory_save", arguments: "{}" },
        extra_content: { google: { thought_signature: "sig-abc" } },
      },
    ];
    const [assistant] = toModelMessages([
      { role: "assistant", content: null, tool_calls: signed } as ChatCompletionMessageParam,
    ]);
    expect(assistant).toMatchObject({
      content: [
        {
          type: "tool-call",
          toolCallId: "c",
          providerOptions: { google: { thoughtSignature: "sig-abc" } },
        },
      ],
    });
  });

  it("adds no providerOptions for a call the backend never signed", () => {
    const [assistant] = toModelMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }],
      } as ChatCompletionMessageParam,
    ]);
    expect((assistant as { content: unknown[] }).content[0]).not.toHaveProperty("providerOptions");
  });

  it("keeps assistant text alongside its tool calls", () => {
    const [assistant] = toModelMessages([
      {
        role: "assistant",
        content: "let me look",
        tool_calls: [
          { id: "c", type: "function", function: { name: "t", arguments: "{}" } },
        ],
      } as ChatCompletionMessageParam,
    ]);
    expect(assistant).toMatchObject({
      content: [
        { type: "text", text: "let me look" },
        { type: "tool-call", toolName: "t" },
      ],
    });
  });
});

describe("chatCompletion end to end, only the network stubbed", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub global fetch (what the provider uses when given none) and record the body. */
  function stubEndpoint(captured: { body?: Record<string, unknown> }, completion: unknown) {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
  }

  const completion = {
    id: "1",
    object: "chat.completion",
    created: 0,
    model: "gemma:12b",
    choices: [
      { index: 0, message: { role: "assistant", content: "  hi  " }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };

  it("carries the declared backend's thinking knob all the way to the wire", async () => {
    const { chatCompletion } = await import("./client");
    const captured: { body?: Record<string, unknown> } = {};
    stubEndpoint(captured, completion);

    const result = await chatCompletion(
      { baseUrl: "https://inference.invalid/v1", apiKey: null, backend: "ollama" },
      { model: "gemma:12b", messages: [{ role: "user", content: "hi" }], reasoning: "off" },
    );

    // The point of the whole layer: the operator named Ollama, so the value
    // measured to actually stop it thinking is what reached the endpoint.
    expect(captured.body?.reasoning_effort).toBe("none");
    expect(result.content).toBe("hi");
    expect(result.model).toBe("gemma:12b");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.responseBody).toMatchObject({ id: "1" });
    expect(result.requestBody).toBeTruthy();
  });

  it("sends no vendor field when the backend is left generic", async () => {
    const { chatCompletion } = await import("./client");
    const captured: { body?: Record<string, unknown> } = {};
    stubEndpoint(captured, completion);

    await chatCompletion(
      { baseUrl: "https://inference.invalid/v1", apiKey: null },
      { model: "gemma:12b", messages: [{ role: "user", content: "hi" }], reasoning: "off" },
    );

    // An unnamed endpoint behaves exactly as it did before this layer existed:
    // the conservative "low" the spec defines, never a vendor field.
    expect(captured.body).not.toHaveProperty("think");
    expect(captured.body).not.toHaveProperty("chat_template_kwargs");
    expect(captured.body?.reasoning_effort).toBe("low");
  });

  /**
   * The second live 400 of 2026-08-14, on the Anthropic backend:
   *
   *   LLM endpoint error (400): messages.1: role 'system' must precede an
   *   'assistant' message or end the array
   *
   * The adapter's rewrite is unit-tested on its own; what this adds is the half
   * no pure test can see — that the native provider really does put those turns
   * on the wire as `system` messages in that order, instead of hoisting or
   * reordering them itself.
   */
  it("sends Anthropic a legal arrangement of the interleaved system turns", async () => {
    const { chatCompletion } = await import("./client");
    const captured: { body?: Record<string, unknown> } = {};
    stubEndpoint(captured, {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    await chatCompletion(
      { baseUrl: "https://api.anthropic.invalid/v1", apiKey: "sk-ant-key", backend: "anthropic" },
      {
        model: "claude",
        messages: [
          { role: "system", content: "persona" },
          { role: "system", content: "memory" },
          { role: "user", content: "earlier" },
          { role: "assistant", content: "earlier answer" },
          { role: "system", content: "It is now 14:00." },
          { role: "system", content: "Reply in English." },
          { role: "user", content: "now" },
        ],
      },
    );

    const sent = captured.body?.messages as Array<{ role: string }>;
    // The prompt prefix went where a prefix belongs, and the per-turn directives
    // survived as their own turn rather than being folded into the user's words.
    expect(JSON.stringify(captured.body?.system)).toContain("persona");
    expect(sent.map((m) => m.role)).toEqual(["user", "assistant", "user", "system"]);
    const illegal = sent.filter(
      (m, i) => m.role === "system" && i !== sent.length - 1 && sent[i + 1]?.role !== "assistant",
    );
    expect(illegal).toEqual([]);
  });

  /**
   * Gemini's off-switch is not one field: `thinkingBudget: 0` on the 2.5 family,
   * `thinkingLevel: "minimal"` on Gemini 3, and a 400 if the wrong one is sent.
   * That is the whole reason the adapter hands the *intent* to the provider
   * instead of naming a body field — so what has to be asserted is the two
   * different bodies coming out of the same call, on the wire.
   */
  it.each([
    ["gemini-2.5-flash", { thinkingBudget: 0 }],
    ["gemini-3-pro-preview", { thinkingLevel: "minimal" }],
  ])("resolves 'do not think' per model on Google: %s", async (model, expected) => {
    const { chatCompletion } = await import("./client");
    const captured: { body?: Record<string, unknown> } = {};
    stubEndpoint(captured, {
      candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    });

    await chatCompletion(
      { baseUrl: "https://generativelanguage.invalid", apiKey: "goog-key", backend: "google" },
      { model, messages: [{ role: "user", content: "hi" }], reasoning: "off" },
    );

    const generationConfig = captured.body?.generationConfig as { thinkingConfig?: unknown };
    expect(generationConfig.thinkingConfig).toEqual(expected);
  });

  it("names a context overflow from the endpoint's own error body", async () => {
    const { chatCompletion, isContextOverflowError } = await import("./client");
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ error: { message: "the request exceeds n_ctx" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    const failure = await chatCompletion(
      { baseUrl: "https://inference.invalid/v1", apiKey: null, backend: "llamacpp" },
      { model: "m", messages: [{ role: "user", content: "hi" }] },
    ).catch((err: unknown) => err);

    // The phrasing carries no "context" word, so only the llama.cpp adapter's
    // pattern can see it — and it is read off the body the SDK preserved.
    expect(isContextOverflowError(failure, "llamacpp")).toBe(true);
    expect(isContextOverflowError(failure)).toBe(false);
  });
});

/**
 * The failure this pins, from production (2026-08-14): pointed at Gemini, every
 * reply that touched a tool died on
 *
 *   LLM endpoint error (400): [{"error":{"code":400,"message":"Function call is
 *   missing a thought_signature in functionCall parts. … Additional data,
 *   function call `default_api:memory_save`, position 3", …}}]
 *
 * Round 1 was fine; the round that replayed the call it had just made was not.
 * So the assertion has to be on the **second** request's body — a unit test of
 * the conversion alone would have passed while the bot stayed broken, because
 * the signature has to survive three hops (provider → our OpenAI-shaped
 * conversation → provider) and each half of the SDK keys it differently.
 */
describe("a signed tool call survives the round trip to the wire", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replays Gemini's thought signature on the round that re-sends the call", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const bodies: Array<Record<string, unknown>> = [];
    const rounds = [
      {
        // What Google's OpenAI-compatibility layer answers with: the signature
        // rides `extra_content` on the tool call.
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "memory_save", arguments: '{"text":"likes tea"}' },
              extra_content: { google: { thought_signature: "sig-abc" } },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
      { message: { role: "assistant", content: "noted" }, finish_reason: "stop" },
    ];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 0,
          model: "gemini",
          choices: [rounds[Math.min(bodies.length - 1, rounds.length - 1)]],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await chatCompletionWithTools(
      { baseUrl: "https://generativelanguage.invalid/v1beta/openai", apiKey: "k" },
      {
        model: "gemini",
        messages: [{ role: "user", content: "remember that I like tea" }],
        tools: [
          {
            type: "function",
            function: {
              name: "memory_save",
              description: "save a fact",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          },
        ],
        callTool: async () => ({ text: "saved", isError: false }),
      },
    );

    expect(result.content).toBe("noted");
    expect(bodies).toHaveLength(2);
    const replayed = (bodies[1].messages as Array<{ role: string; tool_calls?: unknown[] }>).find(
      (m) => m.role === "assistant",
    );
    expect(replayed?.tool_calls?.[0]).toMatchObject({
      id: "call_1",
      extra_content: { google: { thought_signature: "sig-abc" } },
    });
  });
});

/**
 * The same round trip as above, on the native Gemini provider — where the
 * signature is a first-class field rather than an `extra_content` blob, and
 * where an unsigned replay is the failure the provider itself warns about.
 */
describe("a signed tool call survives the round trip on the native Google provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("replays the thought signature on the round that re-sends the call", async () => {
    const { chatCompletionWithTools } = await import("./tool-loop");
    const bodies: Array<Record<string, unknown>> = [];
    const rounds = [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: { id: "call_1", name: "memory_save", args: { text: "likes tea" } },
              thoughtSignature: "sig-abc",
            },
          ],
        },
        finishReason: "STOP",
      },
      { content: { role: "model", parts: [{ text: "noted" }] }, finishReason: "STOP" },
    ];
    vi.stubGlobal("fetch", async (_url: URL | string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          candidates: [rounds[Math.min(bodies.length - 1, rounds.length - 1)]],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await chatCompletionWithTools(
      { baseUrl: "https://generativelanguage.invalid", apiKey: "goog-key", backend: "google" },
      {
        model: "gemini-3-pro-preview",
        messages: [{ role: "user", content: "remember that I like tea" }],
        tools: [
          {
            type: "function",
            function: {
              name: "memory_save",
              description: "save a fact",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
          },
        ],
        callTool: async () => ({ text: "saved", isError: false }),
      },
    );

    expect(result.content).toBe("noted");
    expect(bodies).toHaveLength(2);
    const contents = bodies[1].contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const call = contents.flatMap((turn) => turn.parts).find((part) => "functionCall" in part);
    expect(call?.thoughtSignature).toBe("sig-abc");
  });
});

describe("toToolSet", () => {
  it("bridges MCP tools with no execute, so a round stops at the call", () => {
    const set = toToolSet([
      {
        type: "function",
        function: {
          name: "browse_web",
          description: "read a page",
          parameters: { type: "object", properties: { url: { type: "string" } } },
        },
      },
    ]);
    expect(Object.keys(set ?? {})).toEqual(["browse_web"]);
    expect(set?.browse_web).not.toHaveProperty("execute");
  });

  it("is undefined when there are no tools, so the field is omitted entirely", () => {
    expect(toToolSet(undefined)).toBeUndefined();
    expect(toToolSet([])).toBeUndefined();
  });
});
