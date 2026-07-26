# Browsing infrastructure (`link-fetch`)

**Module:** `features/link-fetch/*` · **Dashboard:** none · **Trace scope:** none of
its own

Shared browser plumbing: the headless Chromium singleton, the guarded browser
context (SSRF routing + ad blocking), and the URL safety checks. Everything that
opens a web page in this app goes through here.

> **No tool of its own.** This module used to own the `read_web_page` MCP tool
> (priority 6). That tool was **removed on 2026-07-26** (user decision) along with
> `search_web`: the [browser agent](browser-agent.md) is now the bot's only
> web-facing tool, and it reads pages far better than a one-shot fetch could. The
> read path (`fetch-link.ts`, `format.ts`, `types.ts`, `fetchPageWithPlaywright`)
> was deleted with it; the directory name stays because it is where this
> infrastructure lives.

Its consumers today are `features/browser-agent/server/session.ts` (one guarded
context per run) and the browser agent's `download.ts` (URL checks for direct
downloads).

## The browser

`features/link-fetch/server/playwright.ts` owns the shared Chromium:

- **A single instance** on a `globalThis` singleton — launching costs ~1s, and a
  module-local copy would leak a Chromium process per Next bundle / hot reload. Every
  browser-agent run opens a context on this one browser rather than launching its own.
- **Per-consumer context** (`newGuardedContext`): isolated cookies and a fixed
  user-agent, closed when the run settles. The browser outlives the context, never the
  other way round.
- **Ad/tracker blocking** via the shared Ghostery engine (`adblock.ts`), also a
  `globalThis` singleton. It is matched **inside** the existing `context.route`
  handler rather than through the library's `enableBlockingInPage`, which would
  register its own page route *ahead* of the SSRF guard and `continue()` requests past
  it. The prebuilt engine is downloaded from the Ghostery CDN on first use and held in
  memory; if that fails (offline, CDN down) pages load without ad blocking and the
  next context retries.
- **Lazy `import("playwright")`**, not a top-level import. Playwright is a
  `serverExternalPackage`, and this module is reachable from the instrumentation
  hook via the MCP registry — a static import would pull the native package into the
  server boot graph, so any resolution problem (a missing data file like
  `browsers.json` in the traced standalone output) would crash the whole app at
  startup. Loading it only when a page is actually opened keeps boot independent of
  the browser runtime and confines any Chromium failure to the run that needs it.

In the Docker image, Playwright's bundled browser is absent (it is a glibc build and
the image is Alpine/musl), so the distro Chromium is installed and pointed at via
`CHROMIUM_EXECUTABLE_PATH`.

The context's user-agent identifies the bot honestly, and **that is not what search
engines object to**: swapping it for a Chrome string was measured (2026-07-26) and
made things worse — DuckDuckGo went from a useless shell to a hard `418` block. See
the [engine cascade](browser-agent.md#search--the-engine-cascade), which is built to
survive engines refusing us.

## SSRF defense

The model supplies URLs (the browser agent's navigate and download tools), so this is
the sharpest edge in the app. Two halves, detailed in
[Security](../architecture/security.md#ssrf-defense):

| Half | Module | Rejects |
| --- | --- | --- |
| Static | `url-safety.ts` (pure, unit-tested) | Non-http(s) schemes, embedded credentials, localhost, the Docker host gateway, literal private/loopback/link-local IPs |
| DNS | `server/resolve-safety.ts` | What the hostname *actually resolves to* — re-checked before navigation and on every redirect hop, via redirect interception in `playwright.ts` |

A blocked **navigation** (initial load or a redirect hop) fails the action, and
`consumeBlockedNavigation()` lets the caller name the real reason instead of
Chromium's generic `net::ERR_BLOCKED_BY_CLIENT`. A blocked *subresource* just does not
load.

Accepted residual gap: DNS rebinding (TOCTOU) — a server can answer our lookup with
a public address and Chromium's with a private one. Closing it needs connect-by-IP
pinning, which Playwright does not expose. Verdicts are cached per context to shrink
the window and the cost.

## Configuration

None of its own. It needs a working Chromium — installed by the Docker image, or
`npx playwright install chromium` locally.

## Tests

Unit: `url-safety.test.ts`, `server/resolve-safety.test.ts`.
The browser itself is exercised by the browser agent's gated live suites
(`BROWSER_LIVE=1`).
