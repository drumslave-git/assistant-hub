/**
 * The `model` columns on feedback/preferences/corrections rows are informational
 * only, but must always hold a clean model name (e.g. `gemma3:12b`) — never a
 * situational registry/path prefix like `docker.io/ai/gemma3:12b` (user
 * decision, 2026-07-14).
 */

/** Fallback when no model name can be resolved at all. */
export const UNKNOWN_MODEL = "unknown";

/**
 * Normalize a raw model id to its clean name: trims whitespace and drops any
 * path-style prefix (everything up to the last `/`), keeping the `:tag` part.
 * `docker.io/ai/gemma3:12b` → `gemma3:12b`; `gpt-4o` stays `gpt-4o`.
 */
export function normalizeModelName(raw: string | null | undefined): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return UNKNOWN_MODEL;
  const lastSlash = trimmed.lastIndexOf("/");
  const name = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  return name || UNKNOWN_MODEL;
}
