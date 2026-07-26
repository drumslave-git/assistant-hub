import "server-only";

import type { Page } from "playwright";

import { newGuardedContext, type GuardedContext } from "@/features/link-fetch/server/playwright";
import { isSafePublicUrl, normalizeUrl } from "@/features/link-fetch/url-safety";

import {
  buildLinksScript,
  buildSnapshotScript,
  MAX_PAGE_LINKS,
  MAX_SNAPSHOT_ELEMENTS,
  MAX_SNAPSHOT_TEXT_CHARS,
  REF_ATTR,
  type PageLink,
  type PageSnapshot,
  type SnapshotElement,
} from "../snapshot";

/**
 * One run's live browser session: a guarded context (SSRF routing + adblock, on
 * the shared Chromium singleton) holding one page the agent drives with generic
 * actions. Every action resolves to a fresh {@link PageSnapshot} so the agent's
 * element refs always match the live DOM. Created per run and closed when the
 * run settles — the browser itself outlives the session (recorded singleton
 * decision), the context never does.
 */

const NAVIGATION_TIMEOUT_MS = 60_000;
/** Clicking/typing an element that exists should be near-instant. */
const ACTION_TIMEOUT_MS = 10_000;
/** Grace for the page to react to an action before it is snapshotted. */
const SETTLE_MS = 750;
/** Raw page source is served in bounded windows the agent pages through. */
const MAX_SOURCE_CHARS = 20_000;
/** Bounds for the wait tool — long stalls belong to navigation timeouts. */
const MAX_WAIT_SECONDS = 30;

/** JPEG quality for viewport screenshots shown to the model. */
const SCREENSHOT_QUALITY = 70;

/** How many recent network responses to keep for `browser_get_network`. */
const NETWORK_CAP = 500;

/** One observed network response, surfaced so the agent can find real media URLs. */
export interface NetworkEntry {
  url: string;
  method: string;
  /** Playwright resource type: document, xhr, fetch, media, image, script, … */
  resourceType: string;
  status: number;
  /** Response `content-type` (first token), or "". */
  contentType: string;
}

export class BrowserAgentSession {
  private guarded: GuardedContext | null = null;
  private page: Page | null = null;
  private closed = false;
  /** Ring buffer of observed responses — the raw material for finding media URLs. */
  private network: NetworkEntry[] = [];

  /** Lazily open the guarded context + page on first use. */
  private async ensurePage(): Promise<Page> {
    if (this.closed) throw new Error("Browser session is closed");
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.guarded) {
      this.guarded = await newGuardedContext();
      // A click that opens a new tab (target=_blank, window.open) moves the
      // story there — adopt the newest page so the agent follows its own action.
      this.guarded.context.on("page", (page) => {
        this.page = page;
      });
      // Record every response across every page in the context, so the agent can
      // inspect the traffic itself and discover the real file/stream URL a player
      // fetched — no media-sniffing heuristics baked into the code.
      this.guarded.context.on("response", (response) => {
        try {
          const request = response.request();
          this.network.push({
            url: response.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            status: response.status(),
            contentType: (response.headers()["content-type"] ?? "").split(";")[0].trim(),
          });
          if (this.network.length > NETWORK_CAP) this.network.shift();
        } catch {
          // A response that vanished before we read it is not worth failing over.
        }
      });
    }
    this.page = await this.guarded.context.newPage();
    return this.page;
  }

  /**
   * The network responses observed so far (newest last), optionally filtered to
   * those whose URL or content-type contains `filter` (case-insensitive). This is
   * how the agent locates the actual media/stream URL a player loaded — it reads
   * the traffic and decides, rather than the code guessing what "the video" is.
   */
  getNetwork(filter?: string): NetworkEntry[] {
    const needle = filter?.trim().toLowerCase();
    const entries = needle
      ? this.network.filter(
          (e) => e.url.toLowerCase().includes(needle) || e.contentType.toLowerCase().includes(needle),
        )
      : this.network;
    return entries.slice();
  }

  /** Current page URL, or null before the first navigation. */
  currentUrl(): string | null {
    const url = this.page && !this.page.isClosed() ? this.page.url() : null;
    return url && url !== "about:blank" ? url : null;
  }

  /** Page identity for naming downloads (title + URL). */
  async pageMeta(): Promise<{ url: string | null; title: string | null }> {
    if (!this.page || this.page.isClosed()) return { url: null, title: null };
    return {
      url: this.currentUrl(),
      title: (await this.page.title().catch(() => "")).trim() || null,
    };
  }

  /**
   * Re-read the current page: tag interactive elements with numbered refs and
   * return the readable snapshot. Waits out the settle grace first so an action
   * that triggered a load is captured after the page reacted.
   */
  async read(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const title = (await page.title().catch(() => "")).trim();
    const result = (await page.evaluate(buildSnapshotScript(REF_ATTR, MAX_SNAPSHOT_ELEMENTS))) as {
      text: string;
      elements: SnapshotElement[];
    };
    return {
      url: page.url(),
      title,
      text: result.text.replace(/\s+/g, " ").trim().slice(0, MAX_SNAPSHOT_TEXT_CHARS),
      elements: result.elements,
    };
  }

  /**
   * The current page's outbound links with the text around each — a list-shaped
   * page read as data. Same settle grace as {@link read}, so a page that is still
   * rendering gets the same chance.
   */
  async links(limit: number = MAX_PAGE_LINKS): Promise<PageLink[]> {
    const page = await this.ensurePage();
    await page.waitForLoadState("domcontentloaded", { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    return (await page.evaluate(buildLinksScript(limit))) as PageLink[];
  }

  /** Open a URL (SSRF-checked before and during navigation). */
  async navigate(rawUrl: string): Promise<PageSnapshot> {
    const url = normalizeUrl(rawUrl);
    if (!url || !isSafePublicUrl(url)) {
      throw new Error("URL blocked for safety (private network or unsupported scheme)");
    }
    const page = await this.ensurePage();
    if (!this.guarded || !(await this.guarded.hostAllowed(new URL(url).hostname))) {
      throw new Error("URL blocked for safety (hostname resolves to a private network address)");
    }
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS });
    } catch (err) {
      throw this.namedNavigationError(err);
    }
    return this.read();
  }

  /** Go back one step in the page's history. */
  async back(): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }).catch((err) => {
      throw this.namedNavigationError(err);
    });
    return this.read();
  }

  /** Click the element carrying the given snapshot ref. */
  async click(ref: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    try {
      await page.click(`[${REF_ATTR}="${ref}"]`, { timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw this.namedActionError(err, ref);
    }
    return this.read();
  }

  /** Type into the input carrying the given ref, optionally pressing Enter. */
  async type(ref: number, text: string, submit: boolean): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const selector = `[${REF_ATTR}="${ref}"]`;
    try {
      await page.fill(selector, text, { timeout: ACTION_TIMEOUT_MS });
      if (submit) await page.press(selector, "Enter", { timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      throw this.namedActionError(err, ref);
    }
    return this.read();
  }

  /** Scroll the page by whole viewport heights (positive pages = down). */
  async scroll(direction: "down" | "up", pages: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const sign = direction === "up" ? -1 : 1;
    const count = Math.max(1, Math.min(10, Math.round(pages)));
    await page.evaluate(`window.scrollBy(0, ${sign * count} * window.innerHeight)`);
    return this.read();
  }

  /** Wait for a slow page (bounded), then return the fresh state. */
  async wait(seconds: number): Promise<PageSnapshot> {
    const page = await this.ensurePage();
    const capped = Math.max(1, Math.min(MAX_WAIT_SECONDS, Math.round(seconds)));
    await page.waitForTimeout(capped * 1000);
    return this.read();
  }

  /**
   * Raw HTML source of the current page, in a bounded window starting at
   * `offset` so the agent can page through a large document.
   */
  async source(offset: number): Promise<{ html: string; offset: number; total: number }> {
    const page = await this.ensurePage();
    const full = await page.content();
    const start = Math.max(0, Math.min(Math.round(offset), full.length));
    return { html: full.slice(start, start + MAX_SOURCE_CHARS), offset: start, total: full.length };
  }

  /** JPEG screenshot of the current viewport. */
  async screenshot(): Promise<Buffer> {
    const page = await this.ensurePage();
    return page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY });
  }

  /** Close the context (the shared browser stays up for the next run). */
  async close(): Promise<void> {
    this.closed = true;
    this.page = null;
    if (this.guarded) {
      await this.guarded.context.close().catch(() => {});
      this.guarded = null;
    }
  }

  /** Name a blocked-private navigation instead of Playwright's generic error. */
  private namedNavigationError(err: unknown): Error {
    if (this.guarded?.consumeBlockedNavigation()) {
      return new Error("URL blocked for safety (redirects to a private network address)");
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /** Explain a missing/stale ref in terms the agent can act on. */
  private namedActionError(err: unknown, ref: number): Error {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(message)) {
      return new Error(
        `Element [${ref}] was not found or not interactable — the page may have changed. ` +
          `Re-read the page and use a ref from the fresh element list.`,
      );
    }
    return err instanceof Error ? err : new Error(message);
  }
}
