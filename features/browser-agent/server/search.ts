import "server-only";

import { getWebSearchApiKey } from "@/features/settings/server/service";
import { runWebSearch } from "@/features/web-search/server/search";

import type { PageLink } from "../snapshot";

/**
 * The browser agent's search entry point: find pages by driving a REAL search
 * engine in the run's own browser session.
 *
 * Whatever answers, the agent gets the SAME thing: a numbered list of the top
 * {@link MAX_RESULTS} results, each a title + URL + snippet, which it then decides
 * to open — one, several, or all of them. That uniformity is the point (user
 * decision, 2026-07-26): an engine's live page and the API fallback used to hand
 * the agent two different-shaped things, so its next move depended on which source
 * happened to work. Now it never does.
 *
 * Engines are tried in order — DuckDuckGo, Google, Bing — because any single one
 * may answer a headless browser with a consent wall, a captcha, or a block. Only
 * when all three fail does this fall back to the Tavily API
 * (`features/web-search`), which needs the key in settings; without it the tool
 * reports the failure instead of pretending the search happened.
 *
 * Results are read off the page **structurally** — anchors and the text around
 * them, via the session's generic link primitive — never by matching what the page
 * says. An engine that rendered nothing yields no off-site links, which is exactly
 * how a captcha or consent wall is detected.
 */

/** One engine attempt in the cascade. */
export interface SearchEngine {
  name: string;
  /** The engine's own hostname — its links are navigation, not results. */
  host: string;
  /** The engine's results URL for a query. */
  resultsUrl: (query: string) => string;
}

/**
 * Engines tried in order, before the API fallback. DuckDuckGo leads because it is
 * the one that actually serves this app's headless browser (user decision,
 * 2026-07-26); Google answers with a captcha and Bing with an interstitial, so
 * they now cost nothing when DuckDuckGo works and still cover it when it does not.
 */
export const SEARCH_ENGINES: SearchEngine[] = [
  {
    name: "DuckDuckGo",
    host: "duckduckgo.com",
    resultsUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Google",
    host: "google.com",
    resultsUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  },
  {
    name: "Bing",
    host: "bing.com",
    resultsUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
  },
];

/** Name used for the API fallback in labels, step summaries, and result text. */
export const FALLBACK_SOURCE = "Tavily";

/** How many results the agent is handed, whatever answered. */
export const MAX_RESULTS = 5;

/**
 * Fewest results an engine must yield to count as having answered. A captcha,
 * consent wall, or block page carries no off-site links at all; a thin-but-real
 * results page still carries a few.
 */
const MIN_RESULTS = 3;

/** One extra settle pass for an engine that renders its results client-side. */
const RETRY_WAIT_SECONDS = 3;

/** Snippet length at which a link counts as *described* — a result, not a nav row. */
const MIN_SNIPPET_CHARS = 40;

/** Query parameters search engines hide the real destination behind. */
const REDIRECT_PARAMS = ["uddg", "url", "u", "q"];

/** A search result, in the one shape every source is normalized to. */
export interface SearchResult {
  title: string;
  url: string;
  /** Preview text from the results page or the API — never the page itself. */
  snippet: string;
}

/** What the search produced, ready for the agent's tool result. */
export interface BrowserSearchResult {
  /** Engine name, or {@link FALLBACK_SOURCE} when the API answered. */
  source: string;
  /** The unified list the agent chooses from (empty only on total failure). */
  results: SearchResult[];
  /** Model-facing text: the numbered list, or the failure report. */
  text: string;
  /** Why each earlier attempt was written off, in order. */
  failures: string[];
  /** Set when nothing at all could answer the query. */
  isError?: boolean;
}

/** Collaborators the cascade acts through (all injectable for tests). */
export interface BrowserSearchDeps {
  /** Open a URL (the session's navigate); its snapshot is not used. */
  navigate: (url: string) => Promise<unknown>;
  /** Read the current page's outbound links (the session's link primitive). */
  links: () => Promise<PageLink[]>;
  /** Wait for a slow page to settle (the session's wait). */
  wait: (seconds: number) => Promise<unknown>;
  /** Called before each attempt with its source name — drives the live feed. */
  onAttempt?: (source: string) => void | Promise<void>;
  /** The API fallback; defaults to Tavily with the key from settings. */
  fallback?: (query: string) => Promise<{ ok: boolean; results: SearchResult[]; reason: string }>;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether `host` is the engine's own domain (or a subdomain of it). */
function isEngineHost(host: string, engineHost: string): boolean {
  return host === engineHost || host.endsWith(`.${engineHost}`);
}

/**
 * The real destination behind an engine's redirect wrapper (Google `/url?q=`,
 * DuckDuckGo `/l/?uddg=`, Bing `/ck/a?u=`), or null when the link is plain
 * navigation. Purely mechanical: each candidate parameter is decoded, and the
 * base64 form Bing uses is decoded too, but only a value that parses as an http(s)
 * URL is ever accepted.
 */
export function unwrapRedirect(url: URL): string | null {
  for (const param of REDIRECT_PARAMS) {
    const raw = url.searchParams.get(param);
    if (!raw) continue;
    const candidates = [raw];
    try {
      // Bing wraps the URL as base64url behind a short marker prefix ("a1…").
      const base64 = raw.replace(/^a\d/i, "").replace(/-/g, "+").replace(/_/g, "/");
      candidates.push(Buffer.from(base64, "base64").toString("utf8"));
    } catch {
      // Not base64 — the raw value is the only candidate.
    }
    for (const candidate of candidates) {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.toString();
      } catch {
        // Not a URL — try the next candidate/parameter.
      }
    }
  }
  return null;
}

/**
 * Turn a results page's raw links into the top results. Three structural filters,
 * each earned from a real engine's behaviour and none of them knowing any engine's
 * markup:
 *
 * 1. **Inside the main region.** Off-site-ness alone recognizes nothing: engines
 *    seed their pages with off-site promos (their own app in the App Store, a
 *    sponsored placement) that sit *above* the results, so the first N in DOM order
 *    are ads. A results page marks its results `<main>`/`role="main"` — the HTML
 *    standard's own "this is the content, the rest is chrome". A page with no main
 *    region yields nothing, which is the honest answer: an engine that served us a
 *    consent wall or a bare shell has no results to give, and the cascade should
 *    move on rather than hand the agent a menu.
 * 2. **The repeated block.** Within main, links are bucketed by their structural
 *    {@link PageLink.group} signature; results come from a template and repeat,
 *    while stray controls do not. The winning bucket is the one with the most
 *    *described* members (a result carries a snippet), size breaking the tie.
 * 3. **One entry per destination.** Engines link the same result more than once —
 *    the headline and the citation line above it. They are merged, keeping the
 *    title that is a headline rather than a URL, and the longer snippet.
 */
export function extractResults(links: PageLink[], engineHost: string, limit = MAX_RESULTS): SearchResult[] {
  const buckets = new Map<string, SearchResult[]>();
  const byUrl = new Map<string, SearchResult>();

  for (const link of links) {
    if (!link.inMain) continue;

    let parsed: URL;
    try {
      parsed = new URL(link.url);
    } catch {
      continue;
    }

    let url = parsed.toString();
    if (isEngineHost(parsed.hostname.toLowerCase(), engineHost)) {
      const unwrapped = unwrapRedirect(parsed);
      if (!unwrapped) continue;
      const target = new URL(unwrapped);
      if (isEngineHost(target.hostname.toLowerCase(), engineHost)) continue;
      url = unwrapped;
    }

    const key = url.replace(/\/$/, "");
    const existing = byUrl.get(key);
    if (existing) {
      mergeInto(existing, link);
      continue;
    }

    const result: SearchResult = { title: link.title || url, url, snippet: link.snippet };
    byUrl.set(key, result);
    const bucket = buckets.get(link.group);
    if (bucket) bucket.push(result);
    else buckets.set(link.group, [result]);
  }

  let winner: SearchResult[] = [];
  let best = -1;
  for (const bucket of buckets.values()) {
    const described = bucket.filter((r) => r.snippet.length >= MIN_SNIPPET_CHARS).length;
    // Rank by descriptions first, size second — and prefer the earlier bucket on a
    // tie, since the organic list precedes the "related searches" further down.
    const score = described * 1_000 + bucket.length;
    if (score > best) {
      best = score;
      winner = bucket;
    }
  }

  return winner.slice(0, limit).map((r) => ({ ...r, snippet: cleanSnippet(r.snippet, r.url) }));
}

/**
 * Strip the citation line engines print above a description ("example.com ›
 * section › page") out of the snippet. It is pure noise here — the destination is
 * already its own field — and it eats the snippet's length budget. Mechanical: the
 * result's own URL and hostname are removed, then any separator punctuation left
 * at the front.
 */
function cleanSnippet(snippet: string, url: string): string {
  const hosts: string[] = [];
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    // The citation may print the full host or just the registrable domain
    // (`en.wikipedia.org` vs `wikipedia.org`) — strip the longer form first, so
    // removing the shorter one cannot leave a subdomain stranded.
    hosts.push(host);
    const registrable = host.split(".").slice(-2).join(".");
    if (registrable !== host) hosts.push(registrable);
  } catch {
    // Unparseable URL — nothing host-shaped to strip.
  }
  let out = snippet.replace(/https?:\/\/\S+/gi, " ");
  for (const host of hosts) out = out.split(host).join(" ");
  return out
    .replace(/^[\s›»·|/\\–—-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fold a second link to an already-seen destination into the entry kept for it:
 * the better title and the fuller snippet win. "Better" is mechanical — a title
 * carrying a URL is the citation line an engine prints above the headline, so a
 * title without one always beats it; otherwise the longer text wins.
 */
function mergeInto(existing: SearchResult, link: PageLink): void {
  const score = (text: string): number => (/https?:\/\//i.test(text) ? 0 : 1);
  const candidate = link.title.trim();
  if (candidate) {
    const better =
      score(candidate) - score(existing.title) || candidate.length - existing.title.length;
    if (better > 0) existing.title = candidate;
  }
  if (link.snippet.length > existing.snippet.length) existing.snippet = link.snippet;
}

/**
 * Run the query on one engine: its top results, or why it produced none. Each
 * engine gets exactly one second chance, because both ways a first read can miss
 * are timing rather than a verdict — results that paint client-side, and an
 * interstitial redirect that destroys the page mid-read ("Execution context was
 * destroyed").
 */
async function tryEngine(
  engine: SearchEngine,
  query: string,
  deps: BrowserSearchDeps,
): Promise<{ results: SearchResult[]; reason: string }> {
  const collect = async (): Promise<SearchResult[]> =>
    extractResults(await deps.links(), engine.host);

  let firstError: string;
  try {
    const results = await collect();
    if (results.length >= MIN_RESULTS) return { results, reason: "" };
    firstError = describeShortfall(results.length);
  } catch (err) {
    firstError = reason(err);
  }

  try {
    await deps.wait(RETRY_WAIT_SECONDS);
    const results = await collect();
    if (results.length >= MIN_RESULTS) return { results, reason: "" };
    const second = describeShortfall(results.length);
    return {
      results: [],
      reason: firstError === second ? firstError : `${firstError}; after waiting: ${second}`,
    };
  } catch (err) {
    return { results: [], reason: `${firstError}; retry failed: ${reason(err)}` };
  }
}

/** Why a page that loaded still isn't results, in the terms actually observed. */
function describeShortfall(found: number): string {
  return (
    `only ${found} result link${found === 1 ? "" : "s"} on the page ` +
    `— most likely a consent wall, captcha, or block page`
  );
}

/** Tavily via the DB-stored API key — read at call time so a key change applies at once. */
async function tavilyFallback(
  query: string,
): Promise<{ ok: boolean; results: SearchResult[]; reason: string }> {
  const apiKey = await getWebSearchApiKey();
  if (!apiKey) {
    return {
      ok: false,
      results: [],
      reason: "the fallback search API is not configured (no API key set in settings)",
    };
  }
  const result = await runWebSearch(query, { apiKey });
  return {
    ok: result.ok,
    results: result.results
      .slice(0, MAX_RESULTS)
      .map((row) => ({ title: row.title, url: row.url, snippet: row.content })),
    reason: result.reason,
  };
}

/**
 * Search the web for `query`: the engine cascade first, the API fallback last.
 * Never throws — a total failure resolves to an error result naming every attempt,
 * so the agent (and the run's activity feed) sees exactly what was tried.
 */
export async function runBrowserSearch(
  query: string,
  deps: BrowserSearchDeps,
): Promise<BrowserSearchResult> {
  const failures: string[] = [];

  for (const engine of SEARCH_ENGINES) {
    await deps.onAttempt?.(engine.name);
    let attempt: { results: SearchResult[]; reason: string };
    try {
      await deps.navigate(engine.resultsUrl(query));
      attempt = await tryEngine(engine, query, deps);
    } catch (err) {
      attempt = { results: [], reason: reason(err) };
    }
    if (attempt.results.length > 0) {
      return {
        source: engine.name,
        results: attempt.results,
        failures,
        text: formatResults(query, engine.name, failures, attempt.results),
      };
    }
    failures.push(`${engine.name}: ${attempt.reason}`);
  }

  await deps.onAttempt?.(FALLBACK_SOURCE);
  const fallback = await (deps.fallback ?? tavilyFallback)(query).catch((err) => ({
    ok: false,
    results: [],
    reason: reason(err),
  }));

  if (!fallback.ok || fallback.results.length === 0) {
    failures.push(`${FALLBACK_SOURCE}: ${fallback.reason || "returned no results"}`);
    return {
      source: FALLBACK_SOURCE,
      results: [],
      failures,
      isError: true,
      text:
        `Search for "${query}" failed — nothing could answer it:\n` +
        failures.map((f) => `- ${f}`).join("\n") +
        `\nDo not invent results. Either open a specific site you know and read it, ` +
        `or report that the search could not be run.`,
    };
  }

  return {
    source: FALLBACK_SOURCE,
    results: fallback.results,
    failures,
    text: formatResults(query, FALLBACK_SOURCE, failures, fallback.results),
  };
}

/**
 * The one result rendering, used for every source. It tells the agent the same
 * next step regardless of where the list came from: pick the useful ones, open
 * them, and read the actual pages — a snippet is a preview, not an answer.
 */
function formatResults(
  query: string,
  source: string,
  failures: string[],
  results: SearchResult[],
): string {
  const header = [
    `SEARCH RESULTS for "${query}" — ${results.length} result${results.length === 1 ? "" : "s"} via ${source}.`,
    `Open the ones that look useful: navigate to a URL below and read the page. You may ` +
      `open several, or all of them, if the goal needs more than one source. The snippets ` +
      `are previews from the results listing — do not answer from them alone.`,
    ...(failures.length > 0 ? [`(Tried first, without results: ${failures.join("; ")})`] : []),
  ].join("\n");

  const lines = results.map(
    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
  );
  return `${header}\n\n${lines.join("\n\n")}`;
}
