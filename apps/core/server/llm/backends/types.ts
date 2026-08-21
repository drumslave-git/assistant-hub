import "server-only";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { LlmBackendId } from "@/lib/llm-backend";

/**
 * The normalization seam between this app and whichever inference server is
 * configured.
 *
 * Everything here is a *behavioral* difference between servers that all claim to
 * be OpenAI-compatible. Wire-shape differences are the AI SDK provider's job;
 * this interface exists for the things it cannot know — which knob turns a
 * thinking model off, where the thinking text ends up, whether an oversized
 * prompt raises or is silently truncated, and whether two spellings of a model
 * tag are the same model.
 *
 * Adapters are **pure**: no fetch, no SDK, no settings access. They map intent
 * to data and read data back. That keeps every backend difference unit-testable
 * without a server, which is the whole point — a quirk that can only be observed
 * by switching production backends is a quirk that gets re-discovered the hard
 * way (user decision, 2026-08-07).
 */

/**
 * A JSON-serializable value. Request-body extras are declared with it rather
 * than `unknown` because they end up in a JSON body either way — saying so in
 * the type stops a `Date`, a `Map`, or an `undefined` reaching the wire as
 * `null` or vanishing silently.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What the caller wants of a thinking model, independent of how to ask for it. */
export type ReasoningMode =
  /** Do not think. Classification gates and short replies. */
  | "off"
  /** Think briefly if you must. */
  | "low"
  /** Leave the model's default alone. */
  | "default";

/** What a chat request wants, before any backend dialect is applied. */
export interface ChatRequestIntent {
  reasoning?: ReasoningMode;
}

/**
 * The AI SDK's own normalized reasoning setting — the one a provider translates
 * into its native knob *per model*. See
 * {@link LlmBackendAdapter.reasoningSetting}.
 */
export type SdkReasoningSetting = "none" | "minimal" | "low" | "medium" | "high";

/**
 * How a backend behaves when a request exceeds the model's context window.
 *
 * The distinction is not cosmetic. `error` backends let the caller react — the
 * reply path halves its injected history and retries. `truncate` backends drop
 * the overflow silently and answer anyway, so that retry ladder never fires and
 * the model quietly stops seeing the older half of the conversation. Identical
 * code, opposite failure modes; a caller that must not lose context has to know
 * which it is talking to.
 */
export type ContextOverflowBehavior = "error" | "truncate";

export interface LlmBackendAdapter {
  id: LlmBackendId;

  /**
   * Extra request-body fields expressing {@link ChatRequestIntent} in this
   * backend's dialect, merged into the provider options of a chat call.
   *
   * Returns `{}` when the backend has no knob for what was asked — an intent a
   * server cannot express is dropped, never approximated with a field that means
   * something else.
   */
  chatBodyExtras(intent: ChatRequestIntent): Record<string, JsonValue>;

  /**
   * The hidden reasoning text on a raw provider response, or null when there is
   * none. Servers disagree on the field name (`reasoning` vs
   * `reasoning_content`), and the token cost of what lives there is invisible in
   * the visible answer — a 78-character reply measured 3,895 characters of
   * reasoning on the live bot, so this is what makes that cost observable.
   */
  readReasoning(rawResponse: unknown): string | null;

  /**
   * Expresses {@link ChatRequestIntent.reasoning} through the SDK's normalized
   * setting instead of {@link chatBodyExtras}, for a provider that maps that
   * setting to its native knob **per model**.
   *
   * Only Gemini needs this so far, and it needs it badly: "do not think" is
   * `thinkingConfig.thinkingBudget: 0` on the 2.5 family, `thinkingLevel:
   * "minimal"` on Gemini 3, and impossible on 2.5 Pro — sending the wrong one is
   * a 400, so a fixed body field cannot be right for more than one model at a
   * time. The provider already resolves this against the model id it was handed,
   * which is knowledge this layer would otherwise have to copy and keep current.
   *
   * Returns undefined when the intent should leave the model's default alone.
   * Unset (every other backend) means the intent is expressed as body fields.
   */
  reasoningSetting?(intent: ChatRequestIntent): SdkReasoningSetting | undefined;

  /**
   * Rewrites the assembled conversation into an arrangement this backend will
   * accept, without dropping anything the caller put in it.
   *
   * For servers that place no constraints of their own this is unset and the
   * conversation is sent exactly as assembled — which is every backend but one.
   * It exists because a rule about *where a turn may sit* is a property of the
   * server, not of the feature that composed the prompt: the reply path places
   * its system turns for prompt-cache reuse and recency, and it must not have to
   * know which endpoint is configured to do that.
   */
  normalizeMessages?(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[];

  /**
   * Where this backend's model listing hangs off, given the configured base URL,
   * when it is **not** the base the chat routes use.
   *
   * Unset for every server that serves `/models` beside `/chat/completions`,
   * which is what OpenAI-compatibility implies. It exists because a vendor may
   * serve two catalogs on two paths: Z.ai answers `/models` with a subset and
   * `/v1/models` with the full list, while chat exists *only* off the base — so
   * a listing taken from the chat base silently hides models the endpoint will
   * happily complete with, and the settings form then flags the operator's
   * working model as "not served" and clears it on save.
   *
   * A pure string→string map, like everything else here: no fetch, no SDK.
   */
  modelListingBaseUrl?(base: string): string;

  /**
   * Backend-specific context-overflow phrasings, tried in addition to (never
   * instead of) the shared concept matcher in `../client`. Empty when the shared
   * matcher already covers this backend.
   */
  contextOverflowPatterns: readonly RegExp[];

  /** What this backend does with a request that outgrows the context window. */
  contextOverflowBehavior: ContextOverflowBehavior;

  /**
   * The identity a served model id is *grouped* under — for analytics and
   * self-improvement records, never for what is sent on the wire (the configured
   * model string is always sent verbatim, because some servers are case- and
   * prefix-sensitive about it).
   *
   * Ollama tags are case-insensitive, so `gemma3:12b` and `gemma3:12B` are one
   * model that the dashboard was reporting as two.
   */
  normalizeServedModelId(raw: string): string;
}
