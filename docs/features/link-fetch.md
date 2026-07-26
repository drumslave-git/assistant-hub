# Link reading

**Feature id:** `mcp-tools-link-fetch` (trace scope) · **Owning feature string:**
`link-fetch` · **Dashboard:** `/tools` · **Priority 6**

One MCP tool, `read_web_page`: read ONE public page with headless Chromium and
return its readable text, so the model answers from the page instead of from memory.

Rendering with a real browser rather than fetching HTML is the point — most pages
worth reading are client-rendered.

## The tool

Input: `url` — a public http(s) URL.
Output: a text result plus `{ ok, url, title }`.

The description states its limits plainly: it reads a single http(s) page; it cannot
download files (videos, archives, images) and cannot read more than one link at a
time. It also says to use it *whenever the user shares a URL* — reading beats
answering about a page from memory.

Page text is normalized (whitespace collapsed) and capped at 12 000 characters.
Navigation timeout is 60s, waiting for `domcontentloaded`.

## The browser

`features/link-fetch/server/playwright.ts` owns the shared Chromium:

- **A single instance** on a `globalThis` singleton — launching costs ~1s, and a
  module-local copy would leak a Chromium process per Next bundle / hot reload. The
  browser agent reuses this same singleton rather than launching a second browser.
- **Per-read context**: isolated cookies and a fixed user-agent, closed after the
  read.
- **Ad/tracker blocking** via the shared Ghostery engine (`adblock.ts`), also a
  `globalThis` singleton. It is matched **inside** the fetcher's existing
  `context.route` handler rather than through the library's `enableBlockingInPage`,
  which would register its own page route *ahead* of the SSRF guard and
  `continue()` requests past it. The prebuilt engine is downloaded from the Ghostery
  CDN on first use and held in memory; if that fails (offline, CDN down) reads
  proceed without ad blocking and the next read retries.
- **Lazy `import("playwright")`**, not a top-level import. Playwright is a
  `serverExternalPackage`, and this module is reachable from the instrumentation
  hook via the MCP registry — a static import would pull the native package into the
  server boot graph, so any resolution problem (a missing data file like
  `browsers.json` in the traced standalone output) would crash the whole app at
  startup. Loading it only when a page is actually read keeps boot independent of the
  browser runtime and confines any Chromium failure to the read that needs it.

In the Docker image, Playwright's bundled browser is absent (it is a glibc build and
the image is Alpine/musl), so the distro Chromium is installed and pointed at via
`CHROMIUM_EXECUTABLE_PATH`.

## SSRF defense

The model supplies the URL, so this is the sharpest edge in the app. Two halves,
detailed in [Security](../architecture/security.md#ssrf-defense):

| Half | Module | Rejects |
| --- | --- | --- |
| Static | `url-safety.ts` (pure, unit-tested) | Non-http(s) schemes, embedded credentials, localhost, the Docker host gateway, literal private/loopback/link-local IPs |
| DNS | `server/resolve-safety.ts` | What the hostname *actually resolves to* — re-checked before the fetch and on every redirect hop, via redirect interception in `playwright.ts` |

Accepted residual gap: DNS rebinding (TOCTOU) — a server can answer our lookup with
a public address and Chromium's with a private one. Closing it needs connect-by-IP
pinning, which Playwright does not expose. Verdicts are cached per page load to
shrink the window and the cost.

## Failure behavior

`fetchLink` **always resolves**, never throws, so a blocked or failed read hands the
model a clear message instead of breaking the tool call. The formatter mirrors the
web-search contract: always tell the model plainly when a read failed, so it never
pretends it opened a page.

The page fetcher is injectable, so the boundary is unit-testable without launching a
real browser.

## Configuration

None of its own. It needs a working Chromium — installed by the Docker image, or
`npx playwright install chromium` locally.

## Tracing

Every call is its own trace under `mcp-tools-link-fetch` with `read_web_page` as the
action, plus the inline `external_call` event on the reply trace.

## Tests

Unit: `url-safety.test.ts`, `format.test.ts`, `server/fetch-link.test.ts`,
`server/resolve-safety.test.ts`.
Integration: `server/tool-selection.integration.test.ts`.
