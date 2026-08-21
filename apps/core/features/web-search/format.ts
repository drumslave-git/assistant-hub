import type { WebSearchPayload, WebSearchResult, WebSearchSource } from "./types";

/**
 * Pure formatting for web-search results. Turns a raw Tavily payload into the
 * text context injected into the model's turn and the citable source list.
 * Client-safe (no server-only marker) and unit-tested directly.
 */

/** Human-readable message for an error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Build the text the model reads for a successful search: the summary answer
 * (when present) followed by the numbered sources. When nothing came back, it
 * tells the model to answer from general knowledge and flag any uncertainty.
 */
export function formatWebSearchContext(query: string, payload: WebSearchPayload): string {
  const parts: string[] = [`Web search for "${query}":`];

  if (payload.answer) {
    parts.push(`\nSummary:\n${payload.answer}`);
  }

  if (payload.results.length > 0) {
    const lines = payload.results.map((r, i) => {
      const snippet = r.content ? `\n${r.content}` : "";
      const link = r.url ? `\nSource: ${r.url}` : "";
      return `${i + 1}. ${r.title}${link}${snippet}`;
    });
    parts.push(`\nSources:\n${lines.join("\n\n")}`);
  }

  if (!payload.answer && payload.results.length === 0) {
    return (
      `Web search was run for "${query}" but returned no results.\n` +
      `Answer from general knowledge and say if you are unsure about current facts.`
    );
  }

  parts.push(
    "\nUse the summary and sources above to answer. " +
      "Do not tell the user to search themselves or that you cannot access the web. " +
      "Cite the relevant source links in your reply when they are useful.",
  );

  return parts.join("\n");
}

/** De-duplicated citable sources (by url) from the payload. */
export function extractWebSearchSources(payload: Pick<WebSearchPayload, "results">): WebSearchSource[] {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();

  for (const result of payload.results) {
    const url = result.url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: result.title.trim() || url, url });
  }

  return sources;
}

/** The text the model reads when the search failed — never pretend it succeeded. */
export function formatWebSearchFailure(query: string, err: unknown): string {
  return (
    `Web search was attempted for "${query}" but failed: ${errorMessage(err)}\n\n` +
    `Tell the user live lookup failed. Do not pretend you searched successfully.`
  );
}

/** Drop empty rows and coerce Tavily's optional fields to strings. */
export function normalizeTavilyResults(
  rows: Array<{ title?: string; url?: string; content?: string }> | undefined,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const row of rows ?? []) {
    const title = row.title?.trim() ?? "";
    const url = row.url?.trim() ?? "";
    const content = row.content?.trim() ?? "";
    if (!title && !url && !content) continue;
    results.push({ title: title || url || "Result", url, content });
  }
  return results;
}
