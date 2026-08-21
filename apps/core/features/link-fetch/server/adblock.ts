import "server-only";

import type { Request as PlaywrightRequest } from "playwright";

/**
 * Shared ad/tracker blocking engine (Ghostery adblocker with the prebuilt
 * EasyList/EasyPrivacy-class lists), kept on a `globalThis` singleton exactly
 * like the shared Chromium — one engine per process, surviving dev hot-reload.
 *
 * The engine is matched inside the fetcher's existing `context.route` handler
 * rather than via the library's `enableBlockingInPage`, which would register its
 * own page route ahead of the SSRF guard and `continue()` requests past it.
 *
 * Best-effort by design: the prebuilt engine is downloaded from the Ghostery CDN
 * on first use and held in memory. If that download fails (offline, CDN down),
 * page reads proceed without ad blocking and the next read retries the load.
 */

/** Bound on the engine download so an unreachable CDN cannot stall a page read. */
const ENGINE_FETCH_TIMEOUT_MS = 15_000;

/** The loaded engine, narrowed to the one question the route handler asks. */
export interface AdBlocker {
  /** True when the request matches an ad/tracker filter and should be aborted. */
  shouldBlock(request: PlaywrightRequest): boolean;
}

interface BlockerStore {
  blocker: AdBlocker | null;
  loading: Promise<AdBlocker | null> | null;
}

const STORE_KEY = Symbol.for("llm-tg-bot.link-fetch.adblocker");

function store(): BlockerStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: BlockerStore };
  if (!g[STORE_KEY]) g[STORE_KEY] = { blocker: null, loading: null };
  return g[STORE_KEY];
}

/**
 * The shared blocking engine, loaded on first use; `null` when unavailable.
 * Safe under concurrency — the first caller loads, the rest await the same
 * promise. A failed load clears the promise so a later read can retry.
 */
export async function getSharedAdBlocker(): Promise<AdBlocker | null> {
  const s = store();
  if (s.blocker) return s.blocker;
  if (!s.loading) {
    s.loading = import("@ghostery/adblocker-playwright")
      .then(({ PlaywrightBlocker, fromPlaywrightDetails }) =>
        PlaywrightBlocker.fromPrebuiltAdsAndTracking((url) =>
          fetch(url, { signal: AbortSignal.timeout(ENGINE_FETCH_TIMEOUT_MS) }),
        ).then((engine): AdBlocker => ({
          shouldBlock: (request) => engine.match(fromPlaywrightDetails(request)).match === true,
        })),
      )
      .then((blocker) => {
        s.blocker = blocker;
        return blocker;
      })
      .catch(() => {
        s.loading = null;
        return null;
      });
  }
  return s.loading;
}

/** Drop the shared engine (for tests); a later read reloads it. */
export function resetSharedAdBlocker(): void {
  const s = store();
  s.blocker = null;
  s.loading = null;
}
