import { afterEach, describe, expect, it, vi } from "vitest";

import { imagePart } from "@/test/__mocks__/vision";
import {
  CONTEXT_EXHAUSTED_MESSAGE,
  isContextOverflowError,
  sanitizeMessagesForTrace,
  toOpenAiBaseUrl,
  type ChatMessage,
} from "./client";

describe("sanitizeMessagesForTrace", () => {
  it("leaves plain-text messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "be nice" },
      { role: "user", content: "hi" },
    ];
    expect(sanitizeMessagesForTrace(messages)).toEqual(messages);
  });

  it("replaces inline image bytes with a compact byte-length marker", () => {
    const base64 = "A".repeat(2048);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "what is this?" }, imagePart(base64)],
      },
    ];
    const [sanitized] = sanitizeMessagesForTrace(messages);
    expect(sanitized.content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,<2048 bytes>" } },
    ]);
  });

  it("does not mutate the input", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,ABCD" } }],
      },
    ];
    sanitizeMessagesForTrace(messages);
    expect((messages[0].content as { type: string }[])[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,ABCD" },
    });
  });

  it("replaces inline audio bytes with a compact byte-length marker, keeping the format", () => {
    const base64 = "B".repeat(4096);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this voice message." },
          { type: "input_audio", input_audio: { data: base64, format: "wav" } },
        ],
      },
    ];
    const [sanitized] = sanitizeMessagesForTrace(messages);
    expect(sanitized.content).toEqual([
      { type: "text", text: "Transcribe this voice message." },
      { type: "input_audio", input_audio: { data: "<4096 bytes>", format: "wav" } },
    ]);
    // The original is untouched.
    const original = (messages[0].content as { input_audio?: { data: string } }[])[1];
    expect(original.input_audio?.data).toBe(base64);
  });
});

describe("isContextOverflowError", () => {
  it.each([
    // llama.cpp oversized-prompt rejection, as mapped through toLlmError
    "LLM endpoint error (400): request (36280 tokens) exceeds the available context size (32768 tokens), try increasing it",
    // llama.cpp mid-generation exhaustion — different path, different wording
    // and status (seen live: trace a4859ca7, 2026-07-21)
    "LLM endpoint error (500): Context size has been exceeded.",
    // llama.cpp (older phrasing)
    "the request exceeds the available context size, try increasing the context size",
    // OpenAI / vLLM (no "exceeded" word at all)
    "This model's maximum context length is 32768 tokens. However, you requested 36280 tokens.",
    // OpenAI structured error code, when it lands in the message
    "400 context_length_exceeded",
    "context overflow detected",
    "prompt is too large for the context window",
    // Our own guard for a response Ollama cut off mid-generation — the contract
    // that lets shrink-and-retry callers recover from it must not drift.
    CONTEXT_EXHAUSTED_MESSAGE,
  ])("matches: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(true);
    expect(isContextOverflowError(message)).toBe(true);
  });

  it.each([
    "LLM endpoint error (500): internal server error",
    "Connection to http://localhost:11434 timed out",
    "LLM returned an empty response",
  ])("does not match other failures: %s", (message) => {
    expect(isContextOverflowError(new Error(message))).toBe(false);
  });

  it("is false for non-error values", () => {
    expect(isContextOverflowError(undefined)).toBe(false);
    expect(isContextOverflowError({ status: 400 })).toBe(false);
  });
});

describe("toOpenAiBaseUrl", () => {
  it("appends /v1 when missing", () => {
    expect(toOpenAiBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
  });

  it("keeps an existing /v1 and strips trailing slashes", () => {
    expect(toOpenAiBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(toOpenAiBaseUrl("http://localhost:11434///")).toBe("http://localhost:11434/v1");
  });

  it("rejects a blank URL", () => {
    expect(() => toOpenAiBaseUrl("   ")).toThrow();
  });
});

// Mock the OpenAI SDK so chatCompletion can be tested without a live endpoint.
const createMock = vi.fn();
vi.mock("openai", () => {
  class OpenAI {
    chat = { completions: { create: createMock } };
    models = { list: vi.fn() };
  }
  class APIError extends Error {}
  class APIConnectionError extends Error {}
  class APIConnectionTimeoutError extends Error {}
  return { default: OpenAI, APIError, APIConnectionError, APIConnectionTimeoutError };
});

describe("chatCompletion", () => {
  afterEach(() => createMock.mockReset());

  const conn = { baseUrl: "http://localhost:11434", apiKey: null };

  it("returns trimmed content, model, and normalized usage", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: "gemma:12b",
      choices: [{ message: { content: "  hello there  " } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });

    const result = await chatCompletion(conn, {
      model: "gemma:12b",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hello there");
    expect(result.model).toBe("gemma:12b");
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("throws service_unavailable when the model returns empty content", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ model: "m", choices: [{ message: { content: "   " } }] });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable" });
  });

  it("names the context window when the empty response was cut off by it", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({
      model: "m",
      choices: [{ message: { content: "" }, finish_reason: "length" }],
    });

    await expect(
      chatCompletion(conn, { model: "m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toMatchObject({ code: "service_unavailable", message: CONTEXT_EXHAUSTED_MESSAGE });
  });

  /**
   * A provider may resolve the requested tag to something else and report that.
   * Docker Model Runner answers `docker.io/ai/gemma4:26B` with the bundle path of
   * the file it loaded. Recording that as the call's identity made one configured
   * model appear as two in the dashboard, so identity stays the requested id and the
   * provider's answer is kept beside it.
   */
  it("keeps the requested id as the identity and records what was served", async () => {
    const { chatCompletion } = await import("./client");
    const bundlePath =
      "/models/bundles/sha256/95c8f7ac704f39390021259feb3d4849e85b42dca6b63014479fa4c3d48b4d86/model/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf";
    createMock.mockResolvedValue({
      model: bundlePath,
      choices: [{ message: { content: "hi" } }],
    });

    const result = await chatCompletion(conn, {
      model: "docker.io/ai/gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.model).toBe("docker.io/ai/gemma4:26B");
    expect(result.servedModel).toBe(bundlePath);
  });

  it("leaves servedModel unset when the provider reports no model", async () => {
    const { chatCompletion } = await import("./client");
    createMock.mockResolvedValue({ choices: [{ message: { content: "hi" } }] });

    const result = await chatCompletion(conn, {
      model: "gemma4:26B",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.model).toBe("gemma4:26B");
    expect(result.servedModel).toBeUndefined();
  });
});

describe("llmUsageOf", () => {
  it("records the requested id and the served one side by side", async () => {
    const { llmUsageOf } = await import("./client");
    expect(
      llmUsageOf({
        model: "docker.io/ai/gemma4:26B",
        servedModel: "/models/bundles/sha256/abc/model/x.gguf",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        latencyMs: 5,
      }),
    ).toEqual({
      model: "docker.io/ai/gemma4:26B",
      servedModel: "/models/bundles/sha256/abc/model/x.gguf",
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      latencyMs: 5,
    });
  });

  it("tolerates a completion that reported no usage", async () => {
    const { llmUsageOf } = await import("./client");
    const usage = llmUsageOf({ model: "m", latencyMs: 2 });
    expect(usage).toMatchObject({ model: "m", latencyMs: 2 });
    expect(usage.promptTokens).toBeUndefined();
  });
});

describe("servedModelOf", () => {
  it("reads the model a response claims to have served", async () => {
    const { servedModelOf } = await import("./client");
    expect(servedModelOf({ model: "gemma4:26B" })).toBe("gemma4:26B");
  });

  it("is undefined when the response claims nothing usable", async () => {
    const { servedModelOf } = await import("./client");
    for (const body of [null, undefined, {}, { model: "" }, { model: "   " }, { model: 7 }, "nope"]) {
      expect(servedModelOf(body)).toBeUndefined();
    }
  });
});
