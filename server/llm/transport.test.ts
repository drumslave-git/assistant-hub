import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { chatBodyExtrasFor } from "./backends";
import { toModelMessages, toToolSet } from "./transport";

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
  it("sends Ollama's think flag, which no typed SDK option covers", async () => {
    const captured: { body?: Record<string, unknown> } = {};
    await generateText({
      model: providerCapturing(captured).chatModel("m"),
      messages: [{ role: "user", content: "hi" }],
      maxRetries: 0,
      providerOptions: { llm: chatBodyExtrasFor("ollama", { reasoning: "off" }) },
    });
    expect(captured.body?.think).toBe(false);
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
