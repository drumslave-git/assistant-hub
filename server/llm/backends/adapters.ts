import "server-only";

import { normalizeModelName } from "@/features/self-improvement/model-name";

import type { ChatRequestIntent, JsonValue, LlmBackendAdapter } from "./types";

/**
 * Field spelling is not free choice. A genuine vendor field is written in its
 * **wire** spelling (`think`, `chat_template_kwargs`, `reasoning_format`) and
 * passes through the provider untouched. `reasoningEffort` is the exception: it
 * is one of the four options the provider types itself, and it writes
 * `reasoning_effort` into the body *after* the passthrough spread — so a
 * snake-case `reasoning_effort` here would be silently overwritten by the unset
 * typed option and never reach the endpoint. It is pinned by a test.
 *
 * The five backend adapters, deliberately in one file: their value is in being
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
 * `reasoning_effort: "none"` is the only thing that stops a thinking model here,
 * and the distinction between it and `"low"` is the whole reason this adapter
 * exists. Measured against a live Ollama 0.32.6 serving a 12B thinking model,
 * one classifier prompt, identical verdict every time:
 *
 * | body                       | completion tokens | latency |
 * | -------------------------- | ----------------- | ------- |
 * | (nothing)                  | 135               | 2269 ms |
 * | `reasoning_effort: "low"`  | 94                | 1784 ms |
 * | `reasoning_effort: "none"` | **17**            | **802 ms** |
 *
 * So `"low"` is not a weaker "off" — it still thinks, which is why the bot's
 * classifiers were paying ~180 reasoning tokens to emit a 15-token verdict while
 * already sending `"low"`.
 *
 * `think` is deliberately **not** sent. It is Ollama's native flag and it works
 * — on `/api/chat`, where it took the same call to 17 tokens — but the
 * OpenAI-compatible `/v1/chat/completions` route this app speaks ignores it
 * (measured: 128 tokens with and without). Sending a field the route drops would
 * only suggest a control we do not have.
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
        return { reasoningEffort: "none" };
      case "low":
        return { reasoningEffort: "low" };
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
        return { chat_template_kwargs: { enable_thinking: false }, reasoningEffort: "low" };
      case "low":
        return { reasoningEffort: "low" };
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
 * Anthropic (Claude) — the one backend that does not speak the OpenAI wire
 * shape at all. The AI SDK's native provider (`@ai-sdk/anthropic`, selected in
 * `../provider`) owns the request translation; what lives here is the same
 * behavioral seam as the other adapters: how to express a reasoning intent,
 * where the thinking text ends up, and how overflow announces itself.
 *
 * These extras are keyed under `providerOptions.anthropic` (the provider's own
 * name), not the shared `llm` key — see `providerOptionsName` in `../provider`.
 *
 * `thinking: {type: "disabled"}` is Anthropic's documented off-switch and is
 * valid across the model range this app can meet (Claude 3.7 through Opus 5;
 * only claude-fable-5 rejects it, and the provider itself guards the one other
 * invalid combination by lowering effort). "low" is deliberately dropped: the
 * knobs that could express it — `effort`, adaptive thinking — are model-gated
 * (a 400 on Haiku/Sonnet 4.5 and older), and an intent a server cannot express
 * is dropped, never approximated.
 */
const anthropic: LlmBackendAdapter = {
  id: "anthropic",
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue> {
    return intent.reasoning === "off" ? { thinking: { type: "disabled" } } : {};
  },
  readReasoning(raw) {
    // The raw body is a native Messages response: `content` is an array of
    // blocks, and thinking arrives as `{type: "thinking", thinking: "…"}`
    // blocks — there is no `choices[0].message` here. Note that on Opus 4.7+
    // the text is empty unless the request opted into a summarized display,
    // which this app does not force: absent text is Anthropic's default, not
    // a missing channel.
    const body = raw as { content?: unknown } | null | undefined;
    if (!body || !Array.isArray(body.content)) return null;
    const text = body.content
      .filter(
        (block): block is { type: string; thinking: string } =>
          !!block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "thinking" &&
          typeof (block as { thinking?: unknown }).thinking === "string",
      )
      .map((block) => block.thinking.trim())
      .filter(Boolean)
      .join("\n");
    return text || null;
  },
  // "prompt is too long: 215631 tokens > 204698 maximum" — carries no
  // "context" word, so the shared concept matcher cannot see it.
  contextOverflowPatterns: [/prompt is too long/i],
  contextOverflowBehavior: "error",
  normalizeServedModelId(raw) {
    // Anthropic model ids are exact, versioned strings; case is preserved.
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
      ? { reasoningEffort: "low" }
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

export const LLM_BACKEND_ADAPTERS = {
  ollama,
  llamacpp,
  vllm,
  anthropic,
  "openai-compatible": generic,
} as const;
