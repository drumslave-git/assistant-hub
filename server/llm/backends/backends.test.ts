import { describe, expect, it } from "vitest";

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
  it("Ollama sends its own think flag, because it was measured ignoring reasoning_effort", () => {
    expect(chatBodyExtrasFor("ollama", { reasoning: "off" })).toEqual({
      think: false,
      reasoningEffort: "low",
    });
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

  it("leaves the model alone when no reasoning preference was expressed", () => {
    for (const id of LLM_BACKEND_IDS) {
      expect(chatBodyExtrasFor(id, {})).toEqual({});
      expect(chatBodyExtrasFor(id, { reasoning: "default" })).toEqual({});
    }
  });

  it("never sends one backend's vendor flag to another", () => {
    for (const id of LLM_BACKEND_IDS) {
      const body = chatBodyExtrasFor(id, { reasoning: "off" });
      if (id !== "ollama") expect(body).not.toHaveProperty("think");
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
});

describe("context overflow", () => {
  it("knows Ollama truncates silently while the others raise", () => {
    expect(truncatesOnOverflow("ollama")).toBe(true);
    expect(truncatesOnOverflow("llamacpp")).toBe(false);
    expect(truncatesOnOverflow("vllm")).toBe(false);
    expect(truncatesOnOverflow("openai-compatible")).toBe(false);
  });

  it("adds the llama.cpp phrasings the shared concept matcher cannot see", () => {
    const patterns = adapterFor("llamacpp").contextOverflowPatterns;
    expect(patterns.some((p) => p.test("the request exceeds n_ctx"))).toBe(true);
    expect(patterns.some((p) => p.test("KV cache is full"))).toBe(true);
  });
});

describe("served model identity", () => {
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
