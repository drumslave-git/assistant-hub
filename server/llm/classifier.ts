import "server-only";

import type { LlmRuntime } from "@/features/settings/server/service";
import type { ReasoningMode } from "./backends";
import { chatCompletion, type ChatCompletionResult, type ChatMessage } from "./client";

/**
 * The **classification** call shape, shared by everything that asks the model
 * one question about one piece of text and expects a small JSON verdict back:
 * the addressing analyzer and its verifier, the honesty gate over a drafted
 * reply, and the standing-task match. No tools, no history, no persona —
 * not a conversation.
 *
 * It lives here rather than in the Telegram runtime so the settings probe can
 * exercise the *same* call the bot makes, and so the two call sites in the
 * reply path cannot drift apart on reasoning effort or budget. The runtime is a
 * parameter (resolved by the caller from `getClassifierRuntime`), which keeps
 * this module free of settings imports at call time and matches how the other
 * `server/llm/*` helpers take theirs.
 */

/**
 * What the classifiers ask of a thinking model: nothing.
 *
 * These calls answer with a small JSON verdict — `{"name_match": "absent",
 * "matched_text": null}` — and were measured spending ~180 reasoning tokens to
 * produce 15 tokens of it. Against the live Ollama, on one such prompt with an
 * identical verdict every time:
 *
 * | body                       | completion tokens | latency |
 * | -------------------------- | ----------------- | ------- |
 * | (nothing)                  | 135               | 2269 ms |
 * | `reasoning_effort: "low"`  | 94                | 1784 ms |
 * | `reasoning_effort: "none"` | **17**            | **802 ms** |
 *
 * "low" was what this sent before, on the assumption that it bounded the
 * thinking. It does not — it still thinks, which is why the two gates were 37%
 * of all LLM wall time while already asking for less.
 *
 * The adapter decides which field carries this (`server/llm/backends`), so an
 * endpoint left on the generic backend still gets the conservative "low" it
 * always did; only a named backend gets its measured off switch.
 */
export const CLASSIFIER_REASONING: ReasoningMode = "off";

/**
 * Generation bound for a classification. Their answer is a small JSON verdict,
 * but the configured model may be a thinking model — measured on the live bot,
 * unbounded thinking cost up to ~1,000 tokens (14s) per verdict.
 *
 * The token cap is a hard stop against runaway generation, not the thinking
 * control — {@link CLASSIFIER_REASONING} is that. It stays roomy (3,000) on
 * purpose: a truncated verdict reads as "not addressed", i.e. a missed summons,
 * and a 1,000-token cap truncated 3 of 8 probe calls mid-think
 * (`finish_reason: "length"`, empty content) back when thinking could not be
 * switched off. With reasoning off a verdict costs ~17 tokens, so the cap
 * should now never be reached at all — it is there for the backend that ignores
 * the switch. User decision, 2026-08-01: thinking capped.
 */
export const CLASSIFIER_MAX_TOKENS = 3_000;

/**
 * What the honesty gate is allowed to spend before it gives up.
 *
 * Deliberately far below {@link CLASSIFIER_MAX_TOKENS}, because the two
 * classifiers fail in opposite directions. A truncated addressing check is a
 * missed summons — the bot stays silent when it was called — so that one is
 * given room. A truncated honesty gate abstains, and abstaining is exactly the
 * behaviour the app had before the gate existed: the reply goes out as written.
 * Its worst case is therefore pure cost, and cost is what these bound.
 *
 * Sized from this endpoint's own traces: a classifier call of this shape answers
 * in 120–160 completion tokens in 3–5s. The cap is ~5x a normal verdict and the
 * timeout ~4x a normal call, so neither can bite a verdict that was going to
 * arrive; what they cut off is a model that has started circling. It did, on day
 * one (trace `ab4fc127…`, 2026-08-07): 3,000 tokens and 40 seconds on a
 * two-sentence reply, no verdict, on a turn that took 60s in total. The gate
 * abstained correctly and the user still waited for it.
 *
 * The timeout measures the wire, not the in-app queue (see `chatCompletion`), so
 * a busy endpoint does not spend it before the request is even sent.
 */
export const HONESTY_GATE_MAX_TOKENS = 800;
export const HONESTY_GATE_TIMEOUT_MS = 20_000;

/** Per-call overrides — only where a caller has a reason (see above). */
export interface ClassifierBudget {
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Run one classification against the classifier role's resolved runtime. Only
 * the budget varies between callers; model, connection and reasoning effort are
 * decided here so every classification is the same call.
 */
export function runClassifier(
  runtime: LlmRuntime,
  messages: ChatMessage[],
  budget?: ClassifierBudget,
): Promise<ChatCompletionResult> {
  return chatCompletion(
    { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend },
    {
      model: runtime.model,
      messages,
      maxTokens: budget?.maxTokens ?? CLASSIFIER_MAX_TOKENS,
      ...(budget?.timeoutMs !== undefined ? { timeoutMs: budget.timeoutMs } : {}),
      reasoning: CLASSIFIER_REASONING,
    },
  );
}
