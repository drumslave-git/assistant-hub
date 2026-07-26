# Search fallback (Tavily)

**Module:** `features/web-search/*` · **Dashboard:** `/settings` (the API key) ·
**Trace scope:** none of its own

[Tavily](https://tavily.com) search, used **only** as the last resort of the browser
agent's [engine cascade](browser-agent.md#search--the-engine-cascade): when neither
Google, Bing, nor DuckDuckGo will render a results page in the real browser, the run
falls back to this API so the agent gets *something* instead of nothing.

> **No tool of its own.** This module used to own the `search_web` MCP tool
> (priority 5). That tool was **removed on 2026-07-26** (user decision) along with
> `read_web_page`: the bot searches by browsing now. What survives is the API client,
> called from `features/browser-agent/server/search.ts`.

## The call

`POST https://api.tavily.com/search` with `search_depth: "basic"`,
`include_answer: true`, and a bounded `max_results` (5, a code constant). The response
becomes the citable source list (`format.ts` — pure, client-safe, unit-tested
directly). `runWebSearch` also returns the normalized rows (title + url + snippet),
which is what the cascade actually uses: it renders them into the **same numbered
list** it builds from an engine's results page, so the agent cannot tell — and does
not have to care — which source answered.

## Failure behavior

`runWebSearch` **always resolves**, never throws. A missing API key or a failed call
comes back as a plain reason, which the cascade appends to its list of attempts — so
a run whose search found nothing tells the agent (and the activity feed, and the
trace) exactly what was tried, and instructs it not to invent results.

The API key lives in DB-backed settings (`settings.tavily_api_key`) and is read at
**call time**, so rotating it takes effect immediately with no restart.

## Configuration

| Setting | Effect |
| --- | --- |
| `tavilyApiKey` (Settings → Integrations) | Unset: a run whose engines are all blocked reports the search as failed. `webSearchConfigured` on the settings read reflects presence |

Leaving it unset is viable as long as one engine works in the browser — today Bing
does, while DuckDuckGo and Google are blocked (see the
[measured table](browser-agent.md#what-the-engines-actually-do-measured-2026-07-26)).
It is insurance, not a dependency — but with only one working engine, thin insurance.

## Tests

`format.test.ts` (payload → context text and sources) and `server/search.test.ts`
(the `fetch` implementation is injectable, so behavior is unit-tested without hitting
the network). The cascade that calls it is covered by
`features/browser-agent/server/search.test.ts` and, live, by
`search-live.integration.test.ts`.
