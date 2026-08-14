import "server-only";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

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

/** A system turn's text; this app never gives one anything but a string. */
function systemText(message: ChatCompletionMessageParam): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => (part as { type?: unknown }).type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Deliver every system turn somewhere Anthropic accepts it, keeping every word
 * and every position.
 *
 * The native API has exactly one unconditional home for instructions: the
 * top-level `system` field, which the provider fills from the system turns at
 * the head of the conversation. A `system` turn *inside* `messages` is a
 * model-gated capability — the provider emits one (and asks for the
 * `mid-conversation-system` beta) whenever a system turn follows any other
 * turn, and a model without it answers
 * `LLM endpoint error (400): role 'system' is not supported on this model`
 * (live, `claude-haiku-4-5-20251001`, 2026-08-14). The previous rewrite here
 * satisfied the *placement* rule those newer models publish ("precede an
 * 'assistant' message or end the array"), which is a rule about where a
 * supported turn may sit — so every reply kept failing on the models that do not
 * support one at all. Measured against the live API on 2026-08-14, that is most
 * of them: of the ten models the operator's key lists, only `claude-fable-5`,
 * `claude-opus-4-8`, `claude-opus-5` and `claude-sonnet-5` accept a
 * mid-conversation system turn; Haiku 4.5, Sonnet 4.5/4.6 and Opus 4.5/4.6/4.7
 * all answer the 400 above.
 *
 * This app interleaves system turns deliberately (see `composeMessages` in
 * `features/bot-messaging/server/service.ts`): the per-chat blocks sit above the
 * history window so the endpoint can reuse its KV-cache prefix, and the per-turn
 * directives sit directly below it so the instruction about "now" is the last
 * thing read before the message being answered.
 *
 * So one mechanical rewrite, no content dropped, no reordering at all:
 *
 * - the leading run stays exactly where it is — the provider lifts it into
 *   `system`, which is where a prompt prefix belongs and what the KV-cache
 *   prefix depends on;
 * - every later run is merged and handed over as a `user` turn in the same
 *   position. The provider folds consecutive user turns into one Anthropic user
 *   message, so the directives arrive as their own text blocks immediately
 *   before the message they are about — the order every other backend gets.
 *
 * The role change is the one semantic change: a directive after the prefix is
 * read as part of the conversation rather than as a standing instruction. That
 * is the strongest delivery this API offers for a turn that cannot be a system
 * turn, and unlike the placement rewrite it is valid on every Claude model.
 */
export function toAnthropicSystemTurns(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [];
  let i = 0;
  // The prefix: consecutive system turns at the very top, passed through
  // untouched for the provider to hoist.
  while (i < messages.length && messages[i].role === "system") {
    out.push(messages[i]);
    i += 1;
  }
  while (i < messages.length) {
    if (messages[i].role !== "system") {
      out.push(messages[i]);
      i += 1;
      continue;
    }
    const run: string[] = [];
    while (i < messages.length && messages[i].role === "system") {
      const text = systemText(messages[i]);
      if (text) run.push(text);
      i += 1;
    }
    // An all-empty run leaves nothing to send: an empty text block is its own
    // 400, and a turn with no words was never carrying an instruction.
    if (run.length > 0) out.push({ role: "user", content: run.join("\n\n") });
  }
  return out;
}

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
  normalizeMessages: toAnthropicSystemTurns,
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
 * Google (Gemini) — the second backend that does not speak the OpenAI wire
 * shape. `@ai-sdk/google` (selected in `../provider`) owns the translation to
 * the native Generative Language API; what lives here is the same behavioral
 * seam as every other adapter.
 *
 * The thinking knob is the interesting one, and it is why
 * {@link LlmBackendAdapter.reasoningSetting} exists: "do not think" is
 * `thinkingBudget: 0` on Gemini 2.5, `thinkingLevel: "minimal"` on Gemini 3, and
 * not expressible at all on 2.5 Pro (its budget has a floor). A body field fixed
 * here would be a 400 on whichever model it was not written for, so the intent is
 * handed to the provider, which resolves it against the model id it was given.
 * `chatBodyExtras` therefore adds nothing: everything this backend needs to be
 * told is already said.
 */
const google: LlmBackendAdapter = {
  id: "google",
  chatBodyExtras(): Record<string, JsonValue> {
    return {};
  },
  reasoningSetting(intent: ChatRequestIntent) {
    switch (intent.reasoning) {
      case "off":
        return "none";
      case "low":
        return "low";
      default:
        return undefined;
    }
  },
  readReasoning(raw) {
    // A native `generateContent` response: thinking arrives as ordinary text
    // parts flagged `thought: true`, interleaved with the answer's parts —
    // there is no `choices[0].message` and no separate reasoning field.
    const body = raw as { candidates?: unknown } | null | undefined;
    if (!body || !Array.isArray(body.candidates)) return null;
    const text = body.candidates
      .flatMap((candidate) => {
        const parts = (candidate as { content?: { parts?: unknown } })?.content?.parts;
        return Array.isArray(parts) ? parts : [];
      })
      .filter(
        (part): part is { thought: true; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as { thought?: unknown }).thought === true &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n");
    return text || null;
  },
  // Gemini reports an oversized prompt as "The input token count (N) exceeds
  // the maximum number of tokens allowed (M)" — no "context" word anywhere, so
  // the shared concept matcher cannot see it.
  contextOverflowPatterns: [/input token count/i, /exceeds the maximum number of tokens/i],
  contextOverflowBehavior: "error",
  normalizeServedModelId(raw) {
    // The listing namespaces ids as `models/gemini-…` while every other route
    // takes the bare id; both must group as one model.
    return normalizeModelName(raw.replace(/^models\//, ""));
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
  google,
  "openai-compatible": generic,
} as const;
