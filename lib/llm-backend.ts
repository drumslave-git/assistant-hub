/**
 * Which inference server sits behind a configured endpoint.
 *
 * Every endpoint this app talks to speaks "OpenAI-compatible", and that is the
 * problem: the label describes the *wire shape*, not the behavior. The same
 * request produces a thinking model that cannot be told to stop thinking on one
 * server and obeys on another; the same context overflow arrives as a 400 here
 * and a 500 there; the same model is `gemma3:12b` and `gemma3:12B` depending on
 * who is asked. Switching backends therefore broke the bot repeatedly, and each
 * break was patched where it surfaced rather than where it came from (user
 * decision, 2026-08-07: normalize per backend instead of layering fixes).
 *
 * So the backend is *declared*, not guessed at runtime: the operator picks it
 * next to the endpoint URL, and `server/llm/backends` turns that choice into the
 * one place where each server's quirks live.
 *
 * Client-safe: ids and labels only, no adapter code and no server imports, so
 * the Settings form can render the dropdown.
 */

/** The inference servers we normalize for. */
export const LLM_BACKEND_IDS = [
  "ollama",
  "llamacpp",
  "vllm",
  "anthropic",
  "google",
  "openai-compatible",
] as const;

export type LlmBackendId = (typeof LLM_BACKEND_IDS)[number];

/**
 * The backend assumed when nothing is configured.
 *
 * Deliberately the conservative one: it sends only what the OpenAI spec
 * guarantees and claims no capability. An endpoint whose backend is unknown —
 * including every row that existed before this field did — behaves exactly as it
 * did before, so adding the field changes no running deployment.
 */
export const DEFAULT_LLM_BACKEND: LlmBackendId = "openai-compatible";

/** Whether a value is one of the known backend ids. */
export function isLlmBackendId(value: unknown): value is LlmBackendId {
  return typeof value === "string" && (LLM_BACKEND_IDS as readonly string[]).includes(value);
}

/** Coerce stored/unknown input to a backend id, falling back to the default. */
export function toLlmBackendId(value: unknown): LlmBackendId {
  return isLlmBackendId(value) ? value : DEFAULT_LLM_BACKEND;
}

/** How one backend is presented in the Settings dropdown. */
export interface LlmBackendOption {
  id: LlmBackendId;
  label: string;
  /** One line on what picking this actually changes. */
  hint: string;
}

export const LLM_BACKENDS: LlmBackendOption[] = [
  {
    id: "ollama",
    label: "Ollama",
    hint: "Thinking is controlled per request; model tags are case-insensitive.",
  },
  {
    id: "llamacpp",
    label: "llama.cpp (llama-server)",
    hint: "Thinking is controlled through the chat template; overflow arrives as 400 or 500.",
  },
  {
    id: "vllm",
    label: "vLLM",
    hint: "Closest to the OpenAI spec; supports reasoning_effort natively.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    hint: "Native Anthropic API — not OpenAI-compatible. Chat and vision roles only; requires an API key.",
  },
  {
    id: "google",
    label: "Google (Gemini)",
    hint: "Native Gemini API — not OpenAI-compatible. Chat, embeddings and images; requires an API key.",
  },
  {
    id: "openai-compatible",
    label: "Generic OpenAI-compatible",
    hint: "Assumes nothing beyond the base spec. Use for OpenAI itself or an unknown server.",
  },
];

/** The display label for a backend id. */
export function llmBackendLabel(id: LlmBackendId): string {
  return LLM_BACKENDS.find((b) => b.id === id)?.label ?? id;
}
