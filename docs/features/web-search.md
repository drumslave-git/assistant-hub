# Web search

**Feature id:** `mcp-tools-web-search` (trace scope) · **Owning feature string:**
`web-search` · **Dashboard:** `/tools` · **Priority 5**

One MCP tool, `search_web`, backed by [Tavily](https://tavily.com): discover pages
and get quick text snippets when the model does not already have a specific URL.

## The tool

`POST https://api.tavily.com/search` with `search_depth: "basic"`,
`include_answer: true`, and a bounded `max_results`. The response is turned into
the text context injected into the model's turn plus a citable source list
(`features/web-search/format.ts` — pure, client-safe, unit-tested directly).

Input: `query` — a short search-engine query, in the user's language when obvious.
Output: a text summary plus a structured payload of sources.

## What the description forbids, and why

The tool description does most of the work of keeping the bot honest, so it is worth
knowing what it says:

- **Only** when the user asks for something to be looked up online. Not for casual
  chat, general knowledge, or opinions nobody asked to verify.
- **Not** to open a specific URL the user already gave, or one already in the
  conversation — a known URL should be *read* directly, not searched for. That is
  what [`read_web_page`](link-fetch.md) is for.
- **Not** to read a live or current value off a named site — a live viewer count,
  live stats, a chart or dashboard, a current price or availability. Search returns
  a cached snippet that is stale or plain wrong for numbers that change by the
  minute and are computed in the browser. Those need the
  [browser agent](browser-agent.md), which actually renders the page.

The description names no other tool by its identifier, per the self-describing rule
— it describes the *kind* of alternative instead.

## Failure behavior

`runWebSearch` **always resolves**, never throws, so the tool can hand the model a
usable success or failure message and the reply carries on. A missing API key
returns a clear error result rather than a broken search.

The API key lives in DB-backed settings (`settings.tavily_api_key`) and is read at
**call time**, so rotating it takes effect immediately with no restart.

## Configuration

| Setting | Effect |
| --- | --- |
| `tavilyApiKey` (Settings → Integrations) | Unset: the tool returns a clear error result. `webSearchConfigured` on the settings read reflects presence |

## Tracing

Every call is its own trace under `mcp-tools-web-search`, with `search_web` as the
action, in addition to the inline `external_call` event on the reply trace.

## Tests

`format.test.ts` (payload → context text and sources), `server/search.test.ts` (the
`fetch` implementation is injectable, so behavior is unit-tested without hitting the
network), `server/tool-selection.integration.test.ts` (a real model actually picks
this tool for the phrasings it should — and does **not** pick it for the ones the
description forbids).
