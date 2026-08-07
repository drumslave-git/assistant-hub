import "server-only";

import { normalizeModelName } from "@/features/self-improvement/model-name";

import type { ChatRequestIntent, JsonValue, LlmBackendAdapter } from "./types";

/**
 * The four backend adapters, deliberately in one file: their value is in being
 * comparable. Reading them side by side is how you see that "turn thinking off"
 * is four different requests, which is the fact that kept breaking the bot on
 * every backend switch.
 *
 * Each mapping below is what the backend's own documentation specifies. None of
 * them can be proven from this repository — only a live endpoint can confirm the
 * server honors the field — so each is pinned by a test on the **body we
 * produce**, and `docs/TODO.md` records which have been confirmed against a real
 * server and which are still assumed.
 */

/** The assistant message of an OpenAI-shaped chat completion, if present. */
function assistantMessage(rawResponse: unknown): Record<string, unknown> | null {
  const body = rawResponse as { choices?: Array<{ message?: unknown }> } | null | undefined;
  const message = body?.choices?.[0]?.message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : null;
}

/** Read the first non-empty string among `fields` off the assistant message. */
function readMessageField(rawResponse: unknown, fields: readonly string[]): string | null {
  const message = assistantMessage(rawResponse);
  if (!message) return null;
  for (const field of fields) {
    const value = message[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/**
 * Ollama.
 *
 * Thinking is a first-class per-request flag (`think`) rather than a sampling
 * parameter, and its OpenAI-compatible route maps `reasoning_effort` onto that
 * flag only on versions new enough to do so — on the live bot, `reasoning_effort:
 * "low"` was measured being ignored while the model kept emitting ~180 reasoning
 * tokens to answer a yes/no question. Both fields are therefore sent: `think` is
 * the one Ollama has always understood, `reasoning_effort` is the one it will
 * understand going forward, and neither is meaningful to the other backends.
 *
 * Context overflow does **not** raise here: Ollama truncates to `num_ctx` and
 * answers anyway. See {@link LlmBackendAdapter.contextOverflowBehavior} for why
 * that matters more than it looks.
 */
const ollama: LlmBackendAdapter = {
  id: "ollama",
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue> {
    switch (intent.reasoning) {
      case "off":
        return { think: false, reasoning_effort: "low" };
      case "low":
        return { think: "low", reasoning_effort: "low" };
      default:
        return {};
    }
  },
  readReasoning(raw) {
    return readMessageField(raw, ["reasoning", "reasoning_content"]);
  },
  contextOverflowPatterns: [],
  contextOverflowBehavior: "truncate",
  normalizeServedModelId(raw) {
    // Ollama tags are case-insensitive: `gemma3:12b` and `gemma3:12B` are one
    // model, which the dashboard was counting as two.
    return normalizeModelName(raw).toLowerCase();
  },
};

/**
 * llama.cpp (`llama-server`).
 *
 * Thinking is a property of the chat template, not of the sampler, so it is
 * turned off by passing template arguments through — `chat_template_kwargs`.
 * `reasoning_format: "none"` additionally stops the server parsing a reasoning
 * block out into its own field, which keeps the raw body honest for the trace.
 *
 * Overflow raises, and words itself differently per path: an oversized prompt is
 * rejected up front with a 400, while running out mid-generation surfaces as a
 * 500 (already pinned in `../client.test.ts`). The shared concept matcher covers
 * both; the extra pattern here is for the phrasing that carries no "context"
 * word at all.
 */
const llamacpp: LlmBackendAdapter = {
  id: "llamacpp",
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue> {
    switch (intent.reasoning) {
      case "off":
        return { chat_template_kwargs: { enable_thinking: false }, reasoning_format: "none" };
      case "low":
        return { reasoning_format: "none" };
      default:
        return {};
    }
  },
  readReasoning(raw) {
    return readMessageField(raw, ["reasoning_content", "reasoning"]);
  },
  contextOverflowPatterns: [/\bn_ctx\b/i, /kv cache is full/i],
  contextOverflowBehavior: "error",
  normalizeServedModelId(raw) {
    // llama-server reports the served model as a file path on some builds.
    return normalizeModelName(raw);
  },
};

/**
 * vLLM.
 *
 * The closest of the four to the published OpenAI spec: `reasoning_effort` is
 * supported natively, and thinking-capable models additionally honor the
 * template argument. Its overflow wording (`maximum context length`) is already
 * matched by the shared concept matcher.
 */
const vllm: LlmBackendAdapter = {
  id: "vllm",
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue> {
    switch (intent.reasoning) {
      case "off":
        return { chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" };
      case "low":
        return { reasoning_effort: "low" };
      default:
        return {};
    }
  },
  readReasoning(raw) {
    return readMessageField(raw, ["reasoning_content", "reasoning"]);
  },
  contextOverflowPatterns: [],
  contextOverflowBehavior: "error",
  normalizeServedModelId(raw) {
    return normalizeModelName(raw);
  },
};

/**
 * Generic OpenAI-compatible — including OpenAI itself.
 *
 * Claims nothing beyond the published spec. `reasoning_effort` is in that spec,
 * so it is sent; no template arguments and no vendor flags are, because a server
 * we know nothing about may reject an unrecognized field outright rather than
 * ignore it. This is the default, and it is what every endpoint configured
 * before this feature existed resolves to — so the layer changes no behavior
 * until an operator names their backend.
 */
const generic: LlmBackendAdapter = {
  id: "openai-compatible",
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue> {
    return intent.reasoning === "off" || intent.reasoning === "low"
      ? { reasoning_effort: "low" }
      : {};
  },
  readReasoning(raw) {
    return readMessageField(raw, ["reasoning", "reasoning_content"]);
  },
  contextOverflowPatterns: [],
  contextOverflowBehavior: "error",
  normalizeServedModelId(raw) {
    // Case is preserved: an unknown server may well be case-sensitive about it.
    return normalizeModelName(raw);
  },
};

export const LLM_BACKEND_ADAPTERS = { ollama, llamacpp, vllm, "openai-compatible": generic } as const;
