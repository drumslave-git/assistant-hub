import { describe, expect, it, vi } from "vitest";

import type { PageLink } from "../snapshot";
import {
  extractResults,
  FALLBACK_SOURCE,
  MAX_RESULTS,
  runBrowserSearch,
  SEARCH_ENGINES,
  unwrapRedirect,
  type BrowserSearchDeps,
} from "./search";

/**
 * Unit coverage for the search cascade. Every collaborator is injected, so no
 * browser launches and no API is called: what is under test is the ORDER of
 * attempts, the structural extraction of results from a page's links, and the fact
 * that every source hands the agent the same shape.
 */

/** Links as a real results page yields them: off-site destinations with previews. */
function resultLinks(count = 8): PageLink[] {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://source-${i + 1}.example/page`,
    title: `Result ${i + 1}`,
    snippet: `What source ${i + 1} says about it, at some descriptive length.`,
    // One template renders them all, so they share a signature.
    group: "div.result>div.results>main",
    inMain: true,
  }));
}

/** Links as a captcha/consent wall yields them: the engine's own navigation only. */
function blockedLinks(engineHost = "duckduckgo.com"): PageLink[] {
  return [
    { url: `https://${engineHost}/about`, title: "About", snippet: "", group: "nav.header", inMain: false },
    {
      url: `https://${engineHost}/privacy`,
      title: "Privacy",
      snippet: "",
      group: "footer",
      inMain: false,
    },
  ];
}

/** Deps resolving per engine name, with a never-answering fallback by default. */
function deps(
  overrides: Partial<BrowserSearchDeps> & { pages?: Record<string, PageLink[] | Error> } = {},
): BrowserSearchDeps & { attempts: string[] } {
  const attempts: string[] = [];
  const pages = overrides.pages ?? {};
  let current = SEARCH_ENGINES[0];
  return {
    attempts,
    navigate: vi.fn(async (url: string) => {
      current =
        SEARCH_ENGINES.find((e) => url.startsWith(new URL(e.resultsUrl("x")).origin)) ?? current;
    }),
    links: vi.fn(async () => {
      const page = pages[current.name] ?? blockedLinks(current.host);
      if (page instanceof Error) throw page;
      return page;
    }),
    wait: vi.fn(async () => undefined),
    onAttempt: (source) => {
      attempts.push(source);
    },
    fallback: vi.fn(async () => ({ ok: false, results: [], reason: "fallback not configured" })),
    ...overrides,
  };
}

describe("unwrapRedirect", () => {
  it("reads the destination out of a plain redirect parameter", () => {
    const url = new URL("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa");
    expect(unwrapRedirect(url)).toBe("https://example.com/a");
  });

  it("decodes the base64 form used behind a marker prefix", () => {
    const encoded = Buffer.from("https://example.com/b").toString("base64url");
    const url = new URL(`https://www.bing.com/ck/a?u=a1${encoded}`);
    expect(unwrapRedirect(url)).toBe("https://example.com/b");
  });

  it("returns null for plain navigation with no destination hidden in it", () => {
    expect(unwrapRedirect(new URL("https://duckduckgo.com/about"))).toBeNull();
    expect(unwrapRedirect(new URL("https://www.google.com/search?q=cats"))).toBeNull();
  });
});

describe("extractResults", () => {
  it("keeps the repeated block's links in page order, capped at the result limit", () => {
    const results = extractResults(resultLinks(9), "duckduckgo.com");
    expect(results).toHaveLength(MAX_RESULTS);
    expect(results[0]).toEqual({
      title: "Result 1",
      url: "https://source-1.example/page",
      snippet: "What source 1 says about it, at some descriptive length.",
    });
  });

  it("skips off-site promo links that sit ABOVE the results", () => {
    // The live failure this was written for: DuckDuckGo seeds its results page with
    // links to its own apps on the App Store / Play Store — off-site, and first in
    // DOM order. They are one-offs, so they lose to the repeated result block.
    const promos: PageLink[] = [
      {
        url: "https://apps.apple.com/app/some-browser/id1",
        title: "Get the app",
        snippet: "",
        group: "div.badge>header",
        inMain: false,
      },
      {
        url: "https://play.google.com/store/apps/details?id=some.browser",
        title: "Get the app",
        snippet: "",
        group: "div.other-badge>header",
        inMain: false,
      },
    ];
    const results = extractResults([...promos, ...resultLinks(4)], "duckduckgo.com");
    expect(results.map((r) => r.url)).toEqual([
      "https://source-1.example/page",
      "https://source-2.example/page",
      "https://source-3.example/page",
      "https://source-4.example/page",
    ]);
  });

  it("prefers the described block over a larger undescribed one", () => {
    // "Related searches" and site menus repeat too, and can outnumber the results;
    // carrying a description is what makes a block the result list.
    const menu: PageLink[] = Array.from({ length: 12 }, (_, i) => ({
      url: `https://menu.example/item-${i}`,
      title: `Item ${i}`,
      snippet: "",
      group: "li.menu-item>ul.menu",
      inMain: true,
    }));
    const results = extractResults([...menu, ...resultLinks(3)], "duckduckgo.com");
    expect(results.map((r) => r.title)).toEqual(["Result 1", "Result 2", "Result 3"]);
  });

  it("drops the engine's own navigation links", () => {
    const links = [...blockedLinks("google.com"), ...resultLinks(2)];
    const results = extractResults(links, "google.com");
    expect(results.map((r) => r.url)).toEqual([
      "https://source-1.example/page",
      "https://source-2.example/page",
    ]);
  });

  it("unwraps a wrapped result rather than discarding it as engine navigation", () => {
    const links: PageLink[] = [
      {
        url: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa",
        title: "Example",
        snippet: "A preview.",
        group: "div.result",
        inMain: true,
      },
    ];
    expect(extractResults(links, "duckduckgo.com")[0].url).toBe("https://example.com/a");
  });

  it("de-duplicates the same destination reached twice", () => {
    const links: PageLink[] = [
      { url: "https://example.com/a", title: "First", snippet: "", group: "div.result", inMain: true },
      // Same destination, written with a trailing slash.
      { url: "https://example.com/a/", title: "First", snippet: "", group: "div.result", inMain: true },
      { url: "https://example.com/b", title: "Second", snippet: "", group: "div.result", inMain: true },
    ];
    expect(extractResults(links, "duckduckgo.com").map((r) => r.title)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("ignores everything outside the page's main region", () => {
    // The live failure this was written for: DuckDuckGo served a shell with no
    // results, and its own promo links (App Store, Play Store, blog) sat in a menu
    // with descriptions — enough to look like a described, repeated block.
    const promos: PageLink[] = Array.from({ length: 6 }, (_, i) => ({
      url: `https://promo-${i}.example/app`,
      title: `Get the app ${i}`,
      snippet: "Download our browser for total privacy, everywhere you go.",
      group: "li.nav-menu__item>ul>ul.nav-menu__list",
      inMain: false,
    }));
    expect(extractResults(promos, "duckduckgo.com")).toEqual([]);
  });

  it("merges an engine's duplicate links, keeping the headline over the citation", () => {
    // Engines print the destination URL above the headline, both linking the same
    // page. The result must read as the headline, with the fuller description.
    const links: PageLink[] = [
      {
        url: "https://example.com/a",
        title: "example.comhttps://example.com › a",
        snippet: "Short.",
        group: "div.cite>li.result",
        inMain: true,
      },
      {
        url: "https://example.com/a",
        title: "The Real Headline",
        snippet: "A much longer description of what the page actually says.",
        group: "h2>li.result",
        inMain: true,
      },
    ];
    const [result] = extractResults(links, "bing.com");
    expect(result.title).toBe("The Real Headline");
    expect(result.snippet).toBe("A much longer description of what the page actually says.");
  });

  it("strips the citation line an engine prints into the description", () => {
    const links: PageLink[] = [
      {
        url: "https://www.gutenberg.org/ebooks/",
        title: "Search | Project Gutenberg",
        snippet: "gutenberg.orghttps://www.gutenberg.org › ebooks Project Gutenberg is a library.",
        group: "h2>li.result",
        inMain: true,
      },
    ];
    expect(extractResults(links, "bing.com")[0].snippet).toBe(
      "ebooks Project Gutenberg is a library.",
    );
  });

  it("strips a citation that prints the registrable domain of a subdomain", () => {
    const links: PageLink[] = [
      {
        url: "https://en.wikipedia.org/wiki/Johannes_Gutenberg",
        title: "Johannes Gutenberg - Wikipedia",
        snippet: "wikipedia.orghttps://en.wikipedia.org › wiki › Johannes_Gutenberg His major work.",
        group: "h2>li.result",
        inMain: true,
      },
    ];
    expect(extractResults(links, "bing.com")[0].snippet).toBe(
      "wiki › Johannes_Gutenberg His major work.",
    );
  });

  it("falls back to the URL when a link carries no text", () => {
    const links: PageLink[] = [
      { url: "https://example.com/a", title: "", snippet: "", group: "div.result", inMain: true },
    ];
    expect(extractResults(links, "duckduckgo.com")[0].title).toBe("https://example.com/a");
  });
});

describe("runBrowserSearch", () => {
  it("tries DuckDuckGo first and returns its top results", async () => {
    const d = deps({ pages: { DuckDuckGo: resultLinks() } });
    const out = await runBrowserSearch("weather in London", d);

    expect(out.source).toBe("DuckDuckGo");
    expect(out.results).toHaveLength(MAX_RESULTS);
    expect(out.failures).toEqual([]);
    expect(out.isError).toBeUndefined();
    expect(d.attempts).toEqual(["DuckDuckGo"]);
    expect(d.navigate).toHaveBeenCalledWith("https://duckduckgo.com/?q=weather%20in%20London");
    expect(d.fallback).not.toHaveBeenCalled();
    // The agent's next step must be spelled out: open results, do not answer from
    // the previews.
    expect(out.text).toContain("5 results via DuckDuckGo");
    expect(out.text).toContain("navigate to a URL below");
    expect(out.text).toContain("1. Result 1\n   https://source-1.example/page");
  });

  it("gives an engine a second chance when its results render late", async () => {
    let rendered = false;
    const d = deps({
      links: vi.fn(async () => {
        const links = rendered ? resultLinks() : blockedLinks();
        rendered = true;
        return links;
      }),
    });
    const out = await runBrowserSearch("late render", d);

    expect(out.source).toBe("DuckDuckGo");
    expect(d.wait).toHaveBeenCalledOnce();
    expect(d.attempts).toEqual(["DuckDuckGo"]);
  });

  it("recovers an engine that threw mid-read but settled on real results", async () => {
    let first = true;
    const d = deps({
      links: vi.fn(async () => {
        if (first) {
          first = false;
          throw new Error("Execution context was destroyed");
        }
        return resultLinks();
      }),
    });
    const out = await runBrowserSearch("cats", d);

    expect(out.source).toBe("DuckDuckGo");
    expect(out.failures).toEqual([]);
  });

  it("falls through a blocked engine and a throwing one to the next", async () => {
    const d = deps({
      pages: {
        DuckDuckGo: blockedLinks(),
        Google: new Error("net::ERR_CONNECTION_REFUSED"),
        Bing: resultLinks(),
      },
    });
    const out = await runBrowserSearch("cats", d);

    expect(out.source).toBe("Bing");
    expect(d.attempts).toEqual(["DuckDuckGo", "Google", "Bing"]);
    expect(out.failures[0]).toMatch(/^DuckDuckGo: only 0 result links/);
    // Both reads failed, so both are named — the first error is never swallowed.
    expect(out.failures[1]).toBe(
      "Google: net::ERR_CONNECTION_REFUSED; retry failed: net::ERR_CONNECTION_REFUSED",
    );
    // What was tried travels with the result, so the feed and the agent both see it.
    expect(out.text).toContain("Tried first, without results:");
    expect(out.text).toContain("net::ERR_CONNECTION_REFUSED");
  });

  it("writes off an engine that renders fewer results than the floor", async () => {
    const d = deps({ pages: { DuckDuckGo: resultLinks(2), Google: resultLinks() } });
    const out = await runBrowserSearch("cats", d);

    expect(out.source).toBe("Google");
    expect(out.failures[0]).toMatch(/^DuckDuckGo: only 2 result links/);
  });

  it("falls back to the API only after all three engines fail, in the same shape", async () => {
    const d = deps({
      fallback: vi.fn(async () => ({
        ok: true,
        reason: "Search completed",
        results: [
          { title: "A source", url: "https://a.example", snippet: "What it says." },
          { title: "Another", url: "https://b.example", snippet: "More." },
        ],
      })),
    });
    const out = await runBrowserSearch("cats", d);

    expect(d.attempts).toEqual(["DuckDuckGo", "Google", "Bing", FALLBACK_SOURCE]);
    expect(d.fallback).toHaveBeenCalledWith("cats");
    expect(out.source).toBe(FALLBACK_SOURCE);
    expect(out.isError).toBeUndefined();
    expect(out.results).toHaveLength(2);
    // Same rendering as an engine's list — the agent's next step does not change.
    expect(out.text).toContain(`2 results via ${FALLBACK_SOURCE}`);
    expect(out.text).toContain("navigate to a URL below");
    expect(out.text).toContain("1. A source\n   https://a.example\n   What it says.");
  });

  it("errors with every attempt named when even the fallback cannot answer", async () => {
    const d = deps();
    const out = await runBrowserSearch("cats", d);

    expect(out.isError).toBe(true);
    expect(out.results).toEqual([]);
    expect(out.failures).toHaveLength(4);
    expect(out.failures[3]).toBe(`${FALLBACK_SOURCE}: fallback not configured`);
    expect(out.text).toContain("Do not invent results");
  });

  it("treats an empty fallback answer as a failure rather than an empty list", async () => {
    const d = deps({
      fallback: vi.fn(async () => ({ ok: true, results: [], reason: "Search completed" })),
    });
    const out = await runBrowserSearch("cats", d);

    expect(out.isError).toBe(true);
    expect(out.failures[3]).toContain(FALLBACK_SOURCE);
  });

  it("does not throw when the fallback itself blows up", async () => {
    const d = deps({
      fallback: vi.fn(async () => {
        throw new Error("Tavily unreachable");
      }),
    });
    const out = await runBrowserSearch("cats", d);

    expect(out.isError).toBe(true);
    expect(out.failures[3]).toBe(`${FALLBACK_SOURCE}: Tavily unreachable`);
  });
});
