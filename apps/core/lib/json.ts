/**
 * Lenient parsing of JSON an LLM was asked to emit.
 *
 * Models routinely wrap a requested JSON object in ``` fences or a sentence of
 * prose ("Here you go:"), which `JSON.parse` rejects outright. Rather than
 * failing a whole background run over punctuation, we take the outermost
 * `{ … }` span and parse that. Pure and client-safe.
 */

/**
 * The first outermost JSON object in `content`, or null when there is none or it
 * does not parse. Deliberately shape-agnostic — callers validate their own fields.
 */
export function extractJsonObject(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(content.slice(start, end + 1));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
