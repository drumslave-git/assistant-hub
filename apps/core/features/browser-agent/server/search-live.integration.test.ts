import { afterAll, describe, expect, it } from "vitest";

import { closeSharedChromium } from "@/features/link-fetch/server/playwright";

import { extractResults, runBrowserSearch, SEARCH_ENGINES } from "./search";
import { BrowserAgentSession } from "./session";

/**
 * Opt-in **real-network** proof of the search cascade: does a real headless
 * Chromium actually get usable results out of DuckDuckGo, Google, and Bing? That
 * is the one thing no unit test can answer — an engine may answer a headless
 * browser with a consent wall or a captcha, which is exactly why the cascade
 * exists — and it is also the only way to know the structural extraction still
 * matches the markup engines ship today.
 *
 * No LLM, no API key, no real user data. The Tavily fallback is stubbed out so a
 * total engine failure fails the test loudly instead of quietly costing an API call.
 *
 * Run: `BROWSER_LIVE=1 npm run test:integration -- browser-agent/server/search-live`
 */
const BROWSER_LIVE = process.env.BROWSER_LIVE === "1";

/**
 * A neutral, stable query whose relevant results are unmistakable. The words are
 * used ONLY here, to prove the engine answered *this* query: a blocked engine
 * sometimes serves a plausible-looking but stale/decoy results page, and counting
 * links alone cannot tell that apart from a real answer. (Production code never
 * inspects result text — see `no-linguistic-heuristics-in-code`; this is a test
 * asserting the world behaves, not logic deciding what to do.)
 */
const QUERY = "gutenberg printing press invention";
const QUERY_TERMS = ["gutenberg", "printing", "press", "druck"];

/** Whether a result plausibly answers {@link QUERY} at all. */
function looksRelevant(entry: { url: string; title: string; snippet: string }): boolean {
  const haystack = `${entry.url} ${entry.title} ${entry.snippet}`.toLowerCase();
  return QUERY_TERMS.some((term) => haystack.includes(term));
}

describe.skipIf(!BROWSER_LIVE)("browser search cascade (real network)", () => {
  afterAll(async () => {
    await closeSharedChromium().catch(() => {});
  });

  it(
    "reports, per engine, how many results a headless browser can extract",
    async () => {
      const verdicts: string[] = [];
      for (const engine of SEARCH_ENGINES) {
        const session = new BrowserAgentSession();
        try {
          await session.navigate(engine.resultsUrl(QUERY));
          let results = extractResults(await session.links(), engine.host);
          if (results.length === 0) {
            await session.wait(3);
            results = extractResults(await session.links(), engine.host);
          }
          const relevant = results.filter(looksRelevant).length;
          verdicts.push(
            results.length > 0
              ? `${engine.name}: ${results.length} results, ${relevant} relevant — top: ${results[0].url}`
              : `${engine.name}: no results extracted @ ${session.currentUrl()}`,
          );
        } catch (err) {
          verdicts.push(`${engine.name}: threw — ${err instanceof Error ? err.message : err}`);
        } finally {
          await session.close();
        }
      }
      console.info(`\n[engines]\n${verdicts.join("\n")}\n`);
      // At least one engine must answer THIS query in the browser, or every run
      // pays the API fallback — the operator needs to know that from a failing
      // test, not from a month of degraded searches.
      expect(verdicts.some((v) => /, [1-9]\d* relevant/.test(v))).toBe(true);
    },
    180_000,
  );

  it(
    "hands the agent a numbered list of real, off-engine URLs to choose from",
    async () => {
      const session = new BrowserAgentSession();
      try {
        const attempts: string[] = [];
        const result = await runBrowserSearch(QUERY, {
          navigate: (url) => session.navigate(url),
          links: () => session.links(),
          wait: (seconds) => session.wait(seconds),
          onAttempt: (source) => {
            attempts.push(source);
          },
          fallback: async () => ({
            ok: false,
            results: [],
            reason: "fallback stubbed out in this test",
          }),
          // This suite proves what the *browser* can do; it must not need (or
          // touch) a database. An empty scoreboard means the configured order.
          stats: { list: async () => [], record: async () => undefined },
        });
        console.info(
          `\n[search] answered by ${result.source} after [${attempts.join(", ")}]` +
            (result.failures.length > 0 ? `\n  failures: ${result.failures.join("\n  ")}` : "") +
            `\n${result.results
              .map((r, i) => `  ${i + 1}. ${r.title}\n     ${r.url}\n     ${r.snippet.slice(0, 90)}`)
              .join("\n")}\n`,
        );

        expect(result.isError).toBeUndefined();
        expect(result.results.length).toBeGreaterThanOrEqual(3);
        expect(result.text).toContain("navigate to a URL below");
        // The whole point of the list: results that actually answer the query.
        // Without this, a decoy results page passes as a successful search.
        expect(result.results.filter(looksRelevant).length).toBeGreaterThanOrEqual(2);

        for (const entry of result.results) {
          const host = new URL(entry.url).hostname;
          // A result that points back at the engine is navigation, not a source.
          expect(SEARCH_ENGINES.some((e) => host.endsWith(e.host))).toBe(false);
          expect(entry.title.length).toBeGreaterThan(0);
        }

        // The agent's next move must actually work: open the first result.
        const page = await session.navigate(result.results[0].url);
        expect(page.url).toBeTruthy();
      } finally {
        await session.close();
      }
    },
    180_000,
  );
});
