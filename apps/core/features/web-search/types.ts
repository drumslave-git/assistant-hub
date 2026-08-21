/**
 * Web-search value shapes, shared by the Tavily client, formatting, and the MCP
 * tool. Pure types — no server-only marker.
 */

/** One normalized search result. */
export interface WebSearchResult {
  title: string;
  url: string;
  content: string;
}

/** A citable source (title + url) surfaced in the structured tool result. */
export interface WebSearchSource {
  title: string;
  url: string;
}

/** The provider payload after normalization. */
export interface WebSearchPayload {
  results: WebSearchResult[];
  answer: string | null;
}
