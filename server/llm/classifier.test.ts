import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatCompletion } from "./client";
import {
  runClassifier,
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_REASONING,
  HONESTY_GATE_MAX_TOKENS,
  HONESTY_GATE_TIMEOUT_MS,
} from "./classifier";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, chatCompletion: vi.fn() };
});

const chatCompletionMock = vi.mocked(chatCompletion);

const runtime = {
  baseUrl: "https://classify.example/v1",
  apiKey: "sk-classify",
  model: "qwen-0.5b",
  backend: "vllm" as const,
};

const messages = [{ role: "user" as const, content: "Is this addressed to the bot?" }];

beforeEach(() => {
  chatCompletionMock.mockReset();
  chatCompletionMock.mockResolvedValue({
    content: "{}",
    model: runtime.model,
    latencyMs: 1,
    requestBody: {},
    responseBody: {},
  });
});

describe("runClassifier", () => {
  it("calls the role's own connection with thinking off and the classifier cap", async () => {
    await runClassifier(runtime, messages);

    const [conn, input] = chatCompletionMock.mock.calls[0];
    // The classifier role's connection, not whatever the chat role points at —
    // the whole reason the role exists is that these may be different hosts.
    expect(conn).toEqual({
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      backend: runtime.backend,
    });
    expect(input.model).toBe(runtime.model);
    expect(input.messages).toBe(messages);
    expect(input.reasoning).toBe(CLASSIFIER_REASONING);
    expect(input.maxTokens).toBe(CLASSIFIER_MAX_TOKENS);
    // No deadline of its own: the shared completion default applies.
    expect(input.timeoutMs).toBeUndefined();
  });

  it("takes the honesty gate's tighter budget when given one", async () => {
    await runClassifier(runtime, messages, {
      maxTokens: HONESTY_GATE_MAX_TOKENS,
      timeoutMs: HONESTY_GATE_TIMEOUT_MS,
    });

    const [, input] = chatCompletionMock.mock.calls[0];
    expect(input.maxTokens).toBe(HONESTY_GATE_MAX_TOKENS);
    expect(input.timeoutMs).toBe(HONESTY_GATE_TIMEOUT_MS);
    // The gate is bounded far below the addressing check on purpose: a
    // truncated gate abstains, a truncated addressing check misses a summons.
    expect(HONESTY_GATE_MAX_TOKENS).toBeLessThan(CLASSIFIER_MAX_TOKENS);
  });
});
