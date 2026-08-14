import "server-only";

import type { LlmBackendId } from "@/lib/llm-backend";

/**
 * Fingerprint the server behind a configured endpoint.
 *
 * This is a *suggestion*, never an authority: the operator picks the backend
 * (user decision, 2026-08-07 — manual selection with a Detect button), and this
 * only saves them from having to know that Ollama answers on `/api/version`
 * while llama-server answers on `/props`. A failed or ambiguous probe returns
 * null and the operator's choice stands untouched.
 *
 * Each probe is a plain unauthenticated GET on the endpoint's **origin** — these
 * are native admin routes that sit beside `/v1`, not under it.
 */

/** How long one probe may take. Short: this runs while an operator waits. */
const PROBE_TIMEOUT_MS = 3_000;

/** The origin a native (non-`/v1`) probe path hangs off. */
function originOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/** GET a probe path, returning its parsed JSON body, or null on any failure. */
async function probe(origin: string, path: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${origin}${path}`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** What a detection attempt found. */
export interface BackendDetection {
  /** The suggested backend, or null when nothing identified itself. */
  backend: LlmBackendId | null;
  /** What the probe saw, for the operator to sanity-check. */
  detail: string;
}

/**
 * Identify the server at `baseUrl`.
 *
 * Ordered most- to least-specific. Ollama and vLLM both serve a `version`
 * endpoint, so Ollama's namespaced `/api/version` is tried first and vLLM's bare
 * `/version` last — the reverse order would let a generic `{version}` body claim
 * an Ollama host.
 */
export async function detectBackend(baseUrl: string): Promise<BackendDetection> {
  const origin = originOf(baseUrl);
  if (!origin) return { backend: null, detail: "Not a valid URL" };

  // Anthropic serves no unauthenticated fingerprint route (every native path
  // wants a key), but it does not need one: the hostname is the signature.
  const hostname = new URL(origin).hostname;
  if (hostname === "api.anthropic.com") {
    return { backend: "anthropic", detail: "Anthropic API (api.anthropic.com)" };
  }
  // Same for Gemini: every native path wants a key, and the hostname says which
  // API this is more reliably than any probe could.
  if (hostname === "generativelanguage.googleapis.com") {
    return { backend: "google", detail: "Google Gemini API (generativelanguage.googleapis.com)" };
  }

  const ollama = await probe(origin, "/api/version");
  if (ollama && typeof ollama.version === "string") {
    return { backend: "ollama", detail: `Ollama ${ollama.version}` };
  }

  // llama-server's `/props` carries the loaded model's template/settings. No
  // version field is guaranteed across builds, so presence is the signal.
  const props = await probe(origin, "/props");
  if (props && ("chat_template" in props || "default_generation_settings" in props)) {
    const model = typeof props.model_path === "string" ? ` (${props.model_path})` : "";
    return { backend: "llamacpp", detail: `llama.cpp${model}` };
  }

  const vllm = await probe(origin, "/version");
  if (vllm && typeof vllm.version === "string") {
    return { backend: "vllm", detail: `vLLM ${vllm.version}` };
  }

  return {
    backend: null,
    detail: "No server signature found — leave it on Generic unless you know otherwise",
  };
}
