import { describe, expect, it } from "vitest";

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { LLM_BACKEND_IDS } from "@/lib/llm-backend";

import { adapterFor, chatBodyExtrasFor, readReasoningFor, truncatesOnOverflow } from "./registry";

/**
 * These pin the three cross-backend breakages the operator confirmed having been
 * bitten by (user decision, 2026-08-07): thinking control, context-overflow
 * shape, and served-model identity.
 *
 * What they assert is the *body we produce* and the *data we read back* — never
 * that a server honors it, which only a live endpoint can show. That split is
 * deliberate: it is what lets a wrong mapping be found and fixed in one place
 * here, rather than by switching production backends and watching what breaks.
 */

/** An OpenAI-shaped completion carrying a reasoning field under `field`. */
function completionWithReasoning(field: string, text: string): unknown {
  return {
    choices: [{ index: 0, message: { role: "assistant", content: "{}", [field]: text } }],
  };
}

describe("thinking control differs per backend", () => {
  // Measured against a live Ollama 0.32.6: "none" took one classifier call from
  // 135 completion tokens to 17, while "low" only reached 94 — it still thinks.
  // The bot was already sending "low", which is why the gates stayed slow.
  it('Ollama needs "none"; "low" is not a weaker "off"', () => {
    expect(chatBodyExtrasFor("ollama", { reasoning: "off" })).toEqual({
      reasoningEffort: "none",
    });
    expect(chatBodyExtrasFor("ollama", { reasoning: "low" })).toEqual({
      reasoningEffort: "low",
    });
  });

  // Ollama's native flag works on /api/chat but is ignored by the /v1 route this
  // app speaks (measured: 128 completion tokens with it and without).
  it("does not send Ollama's native think flag, which the /v1 route drops", () => {
    expect(chatBodyExtrasFor("ollama", { reasoning: "off" })).not.toHaveProperty("think");
  });

  it("llama.cpp turns thinking off through the chat template, not a sampler field", () => {
    expect(chatBodyExtrasFor("llamacpp", { reasoning: "off" })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_format: "none",
    });
  });

  it("vLLM combines the template argument with the spec field", () => {
    expect(chatBodyExtrasFor("vllm", { reasoning: "off" })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoningEffort: "low",
    });
  });

  it("the generic adapter sends only what the OpenAI spec guarantees", () => {
    expect(chatBodyExtrasFor("openai-compatible", { reasoning: "off" })).toEqual({
      reasoningEffort: "low",
    });
  });

  it("Anthropic turns thinking off through its documented thinking switch", () => {
    expect(chatBodyExtrasFor("anthropic", { reasoning: "off" })).toEqual({
      thinking: { type: "disabled" },
    });
  });

  it('Anthropic drops "low" — its briefly-please knobs are model-gated', () => {
    // `effort` and adaptive thinking both 400 on older Claude models, and the
    // adapter cannot know which model the call is for. Dropped, not approximated.
    expect(chatBodyExtrasFor("anthropic", { reasoning: "low" })).toEqual({});
  });

  it("Google states the intent instead of a field, because its knob is per model", () => {
    // `thinkingBudget: 0` (2.5) and `thinkingLevel: "minimal"` (Gemini 3) are
    // both 400s on the other family, so no fixed body field can be right. The
    // provider resolves it against the model id — see `reasoningSetting`.
    expect(chatBodyExtrasFor("google", { reasoning: "off" })).toEqual({});
    expect(adapterFor("google").reasoningSetting!({ reasoning: "off" })).toBe("none");
    expect(adapterFor("google").reasoningSetting!({ reasoning: "low" })).toBe("low");
    expect(adapterFor("google").reasoningSetting!({ reasoning: "default" })).toBeUndefined();
  });

  // Measured live on glm-4.7-flash, same prompt each time: `reasoning_effort`
  // ("none" and "low") and `chat_template_kwargs: {enable_thinking: false}` both
  // came back *with* `reasoning_content`; only the vendor flag removed it. The
  // generic adapter's spec-only body is therefore silently ignored here.
  it("Z.ai only stops thinking on its own flag, not on reasoning_effort", () => {
    expect(chatBodyExtrasFor("zai", { reasoning: "off" })).toEqual({
      thinking: { type: "disabled" },
    });
    const body = chatBodyExtrasFor("zai", { reasoning: "off" });
    expect(body).not.toHaveProperty("reasoningEffort");
    expect(body).not.toHaveProperty("chat_template_kwargs");
  });

  it('Z.ai drops "low" — the flag is all-or-nothing, and off is not what was asked', () => {
    expect(chatBodyExtrasFor("zai", { reasoning: "low" })).toEqual({});
  });

  it("no other backend claims the SDK-level reasoning setting", () => {
    for (const id of LLM_BACKEND_IDS.filter((backend) => backend !== "google")) {
      expect(adapterFor(id).reasoningSetting).toBeUndefined();
    }
  });

  it("leaves the model alone when no reasoning preference was expressed", () => {
    for (const id of LLM_BACKEND_IDS) {
      expect(chatBodyExtrasFor(id, {})).toEqual({});
      expect(chatBodyExtrasFor(id, { reasoning: "default" })).toEqual({});
    }
  });

  it("never sends one backend's vendor flag to another", () => {
    for (const id of LLM_BACKEND_IDS) {
      const body = chatBodyExtrasFor(id, { reasoning: "off" });
      expect(body).not.toHaveProperty("think");
      if (id !== "llamacpp") expect(body).not.toHaveProperty("reasoning_format");
    }
  });
});

describe("reasoning text is read wherever the backend puts it", () => {
  it("reads Ollama's `reasoning` field", () => {
    const raw = completionWithReasoning("reasoning", "the model deliberating");
    expect(readReasoningFor("ollama", raw)).toBe("the model deliberating");
  });

  it("reads the `reasoning_content` spelling the other servers use", () => {
    const raw = completionWithReasoning("reasoning_content", "deliberating elsewhere");
    expect(readReasoningFor("vllm", raw)).toBe("deliberating elsewhere");
    expect(readReasoningFor("llamacpp", raw)).toBe("deliberating elsewhere");
    expect(readReasoningFor("zai", raw)).toBe("deliberating elsewhere");
  });

  it("returns null rather than throwing on a body with no reasoning", () => {
    for (const id of LLM_BACKEND_IDS) {
      expect(readReasoningFor(id, { choices: [{ message: { content: "hi" } }] })).toBeNull();
      expect(readReasoningFor(id, { choices: [] })).toBeNull();
      expect(readReasoningFor(id, null)).toBeNull();
      expect(readReasoningFor(id, "not a completion")).toBeNull();
    }
  });

  it("ignores an empty reasoning field instead of reporting it as present", () => {
    expect(readReasoningFor("ollama", completionWithReasoning("reasoning", "   "))).toBeNull();
  });

  it("reads Anthropic's thinking blocks off the native content array", () => {
    const raw = {
      content: [
        { type: "thinking", thinking: "step one" },
        { type: "thinking", thinking: "step two" },
        { type: "text", text: "the answer" },
      ],
    };
    expect(readReasoningFor("anthropic", raw)).toBe("step one\nstep two");
  });

  it("reads Gemini's thinking off the parts flagged as thoughts", () => {
    // Native `generateContent`: thinking is an ordinary text part carrying
    // `thought: true`, interleaved with the answer — not a separate field.
    const raw = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "weighing it", thought: true },
              { text: "the answer" },
            ],
          },
        },
      ],
    };
    expect(readReasoningFor("google", raw)).toBe("weighing it");
    expect(readReasoningFor("google", { candidates: [{ content: { parts: [{ text: "hi" }] } }] })).toBeNull();
    expect(readReasoningFor("google", { choices: [{ message: { content: "hi" } }] })).toBeNull();
    expect(readReasoningFor("google", null)).toBeNull();
  });

  it("returns null for an Anthropic response with no or empty thinking blocks", () => {
    // Opus 4.7+ omit the text by default — the block is there, the text empty.
    expect(
      readReasoningFor("anthropic", { content: [{ type: "thinking", thinking: "" }] }),
    ).toBeNull();
    expect(readReasoningFor("anthropic", { content: [{ type: "text", text: "hi" }] })).toBeNull();
    expect(readReasoningFor("anthropic", { choices: [{ message: { content: "hi" } }] })).toBeNull();
    expect(readReasoningFor("anthropic", null)).toBeNull();
  });
});

describe("context overflow", () => {
  it("knows Ollama truncates silently while the others raise", () => {
    expect(truncatesOnOverflow("ollama")).toBe(true);
    expect(truncatesOnOverflow("llamacpp")).toBe(false);
    expect(truncatesOnOverflow("vllm")).toBe(false);
    expect(truncatesOnOverflow("anthropic")).toBe(false);
    expect(truncatesOnOverflow("google")).toBe(false);
    expect(truncatesOnOverflow("zai")).toBe(false);
    expect(truncatesOnOverflow("openai-compatible")).toBe(false);
  });

  it("adds the llama.cpp phrasings the shared concept matcher cannot see", () => {
    const patterns = adapterFor("llamacpp").contextOverflowPatterns;
    expect(patterns.some((p) => p.test("the request exceeds n_ctx"))).toBe(true);
    expect(patterns.some((p) => p.test("KV cache is full"))).toBe(true);
  });

  it("adds Anthropic's overflow phrasing, which carries no 'context' word", () => {
    const patterns = adapterFor("anthropic").contextOverflowPatterns;
    expect(patterns.some((p) => p.test("prompt is too long: 215631 tokens > 204698 maximum"))).toBe(
      true,
    );
  });

  it("adds Gemini's overflow phrasing, which carries no 'context' word either", () => {
    const patterns = adapterFor("google").contextOverflowPatterns;
    expect(
      patterns.some((p) =>
        p.test("The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)."),
      ),
    ).toBe(true);
  });

  // The live 400: {"error":{"code":"1261","message":"Prompt exceeds max length"}}
  it("adds Z.ai's overflow phrasing, which names no context either", () => {
    const patterns = adapterFor("zai").contextOverflowPatterns;
    expect(patterns.some((p) => p.test("Prompt exceeds max length"))).toBe(true);
  });
});

describe("model listing location", () => {
  // Measured: `/api/paas/v4/models` answered with 8 ids, `/api/paas/v4/v1/models`
  // with 14 — a strict superset including glm-4.7-flash, which chat completes
  // with. Listing from the chat base would hide it from the settings form and
  // clear a working selection on save.
  it("sends Z.ai's listing to the path that reports the full catalog", () => {
    const zai = adapterFor("zai");
    expect(zai.modelListingBaseUrl!("https://api.z.ai/api/paas/v4")).toBe(
      "https://api.z.ai/api/paas/v4/v1",
    );
    expect(zai.modelListingBaseUrl!("https://api.z.ai/api/paas/v4/")).toBe(
      "https://api.z.ai/api/paas/v4/v1",
    );
    // Idempotent: an operator who already typed the listing path keeps it.
    expect(zai.modelListingBaseUrl!("https://api.z.ai/api/paas/v4/v1")).toBe(
      "https://api.z.ai/api/paas/v4/v1",
    );
  });

  it("leaves every other backend listing from the base it completes on", () => {
    for (const id of LLM_BACKEND_IDS.filter((backend) => backend !== "zai")) {
      expect(adapterFor(id).modelListingBaseUrl).toBeUndefined();
    }
  });
});

describe("served model identity", () => {
  it("strips the namespace Gemini's listing adds, so one model is not two", () => {
    // The listing answers `models/gemini-2.5-flash`; every other route, and the
    // stored selection, use the bare id.
    const google = adapterFor("google");
    expect(google.normalizeServedModelId("models/gemini-2.5-flash")).toBe(
      google.normalizeServedModelId("gemini-2.5-flash"),
    );
    expect(google.normalizeServedModelId("models/gemini-2.5-flash")).toContain("gemini-2.5-flash");
  });

  it("folds Ollama tag case, which the dashboard was counting as two models", () => {
    const ollama = adapterFor("ollama");
    expect(ollama.normalizeServedModelId("gemma3:26B")).toBe("gemma3:26b");
    expect(ollama.normalizeServedModelId("gemma3:26b")).toBe(
      ollama.normalizeServedModelId("gemma3:26B"),
    );
  });

  it("preserves case on backends that may be case-sensitive", () => {
    expect(adapterFor("openai-compatible").normalizeServedModelId("Model-XL")).toBe("Model-XL");
    expect(adapterFor("vllm").normalizeServedModelId("Model-XL")).toBe("Model-XL");
  });

  it("still drops registry and path prefixes on every backend", () => {
    for (const id of LLM_BACKEND_IDS) {
      expect(adapterFor(id).normalizeServedModelId("docker.io/ai/gemma3:12b")).toContain("gemma3");
      expect(adapterFor(id).normalizeServedModelId("docker.io/ai/gemma3:12b")).not.toContain("/");
    }
  });
});

describe("adapterFor", () => {
  it("falls back to the generic adapter so pre-existing settings keep working", () => {
    expect(adapterFor(null).id).toBe("openai-compatible");
    expect(adapterFor(undefined).id).toBe("openai-compatible");
    expect(adapterFor("something-we-never-shipped").id).toBe("openai-compatible");
  });

  it("resolves every declared id to an adapter that reports that id", () => {
    for (const id of LLM_BACKEND_IDS) expect(adapterFor(id).id).toBe(id);
  });
});

/**
 * The reply prompt interleaves system turns on purpose, and Anthropic is the one
 * backend that cannot take them there — a system turn after the prefix is a
 * model-gated capability, and a model without it rejects the role outright. So
 * the arrangement it sends is asserted against that rule directly, message by
 * message, rather than against a hand-copied expected array that would stop
 * meaning anything if the prompt gained a block.
 */
describe("system-turn placement is rewritten only where the server demands it", () => {
  /**
   * Anthropic's rule: the only system turns are the leading run the provider
   * hoists into the top-level `system` field. Anything later is a
   * mid-conversation system message, which
   * `role 'system' is not supported on this model` rejects on 4.5 and older.
   */
  function violations(messages: ChatCompletionMessageParam[]): number[] {
    const prefix = messages.findIndex((message) => message.role !== "system");
    if (prefix === -1) return [];
    return messages.flatMap((message, index) =>
      message.role === "system" && index > prefix ? [index] : [],
    );
  }

  /** The shape `composeMessages` produces for a group reply, abridged. */
  const reply: ChatCompletionMessageParam[] = [
    { role: "system", content: "persona" },
    { role: "system", content: "chat context" },
    { role: "system", content: "memory" },
    { role: "user", content: "earlier" },
    { role: "assistant", content: "earlier answer" },
    { role: "system", content: "sender preferences" },
    { role: "system", content: "It is now 14:00." },
    { role: "system", content: "Reply in English." },
    { role: "user", content: "now" },
  ];

  it("produces an arrangement Anthropic accepts, from the one that 400'd", () => {
    // The prompt as assembled is exactly what the live endpoint rejected.
    expect(violations(reply)).not.toEqual([]);
    expect(violations(adapterFor("anthropic").normalizeMessages!(reply))).toEqual([]);
  });

  it("keeps every block, in order, and the turn it was placed against", () => {
    const sent = adapterFor("anthropic").normalizeMessages!(reply);
    // Nothing dropped: each block still appears, still in composition order.
    const text = sent.map((m) => String(m.content)).join("\n");
    for (const block of ["persona", "chat context", "memory", "It is now 14:00.", "Reply in English."]) {
      expect(text).toContain(block);
    }
    expect(text.indexOf("It is now 14:00.")).toBeLessThan(text.indexOf("Reply in English."));
    // The prefix stays the prefix — the provider lifts it into `system`, and the
    // endpoint's KV-cache reuse depends on it not moving.
    expect(sent[0]).toMatchObject({ role: "system" });
    expect(String(sent[0].content)).toContain("persona");
    // The per-turn directives keep their composed position, directly before the
    // message they are about, and are handed over as the only role this API
    // accepts there.
    expect(sent.at(-1)).toEqual({ role: "user", content: "now" });
    expect(sent.at(-2)).toMatchObject({ role: "user" });
    expect(String(sent.at(-2)!.content)).toContain("Reply in English.");
  });

  it("hands a directive after the prefix over as a user turn, wherever it sits", () => {
    // The enforcement retry: the model's own empty-handed answer, then the
    // correction. Legal placement under the newer models' rule — and still a
    // system turn the older ones refuse, so it converts like any other.
    const enforced: ChatCompletionMessageParam[] = [
      { role: "system", content: "persona" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "I will" },
      { role: "system", content: "you did not" },
    ];
    expect(adapterFor("anthropic").normalizeMessages!(enforced)).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "do it" },
      { role: "assistant", content: "I will" },
      { role: "user", content: "you did not" },
    ]);
  });

  it("drops a run that carries no words rather than sending an empty turn", () => {
    // An empty text block is its own 400, and a turn with nothing in it was
    // never carrying an instruction.
    const blank: ChatCompletionMessageParam[] = [
      { role: "system", content: "persona" },
      { role: "user", content: "hi" },
      { role: "system", content: "   " },
    ];
    expect(adapterFor("anthropic").normalizeMessages!(blank)).toEqual([
      { role: "system", content: "persona" },
      { role: "user", content: "hi" },
    ]);
  });

  it("is not applied to backends that never asked for it", () => {
    for (const id of LLM_BACKEND_IDS.filter((backend) => backend !== "anthropic")) {
      expect(adapterFor(id).normalizeMessages).toBeUndefined();
    }
  });
});
