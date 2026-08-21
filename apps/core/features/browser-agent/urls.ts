/**
 * Pure URL handling for browser-agent runs. Client-safe (no server dependencies)
 * and unit-testable, like `format.ts`.
 *
 * Why this exists (incident, 2026-08-01): the chat model composes the `browse_web`
 * goal and, being a small model, re-types URLs token by token — one run flipped a
 * digit in a 19-digit tweet id and the agent then downloaded an unrelated video as
 * a "similar" substitute. Hard data must not pass through an LLM: the URLs are
 * extracted from the triggering message in code, carried on the run verbatim, and
 * — for a run whose download rights were lent by a standing rule rather than the
 * sender — the download tools accept only URLs from the same set.
 */

/**
 * `http(s)` URLs as people paste them into chat. Trailing punctuation that is
 * far more likely sentence than URL (`.`, `,`, `)`, …) is trimmed.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

/** Characters a chat sentence commonly appends to a pasted URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"«»]+$/;

/** Extract every http(s) URL from a chat message, in order, de-duplicated. */
export function extractMessageUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!url || seen.has(url)) continue;
    // Only well-formed URLs make it onto the run — the set doubles as the
    // download allow-list, so garbage must not widen it.
    try {
      new URL(url);
    } catch {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/**
 * Hosts that are the same site under two names, mapped to one canonical form.
 * Needed because the agent legitimately rewrites share links to their site's
 * main domain (`youtu.be/x` → `youtube.com/watch?v=x`) and Twitter answers to
 * both of its names.
 */
const HOST_ALIASES: Record<string, string> = {
  "youtu.be": "youtube.com",
  "x.com": "twitter.com",
};

/**
 * A host reduced to the domain that identifies the site: leading `www.` dropped,
 * subdomains folded to the registrable domain (`music.youtube.com` →
 * `youtube.com`, `vm.tiktok.com` → `tiktok.com`), aliases canonicalized. Naive
 * two-label folding — none of the media sites the feature targets use a
 * multi-label public suffix.
 */
export function canonicalHost(host: string): string {
  const lower = host.toLowerCase().replace(/^www\./, "");
  const folded = lower.split(".").slice(-2).join(".");
  return HOST_ALIASES[lower] ?? HOST_ALIASES[folded] ?? folded;
}

/**
 * Whether a URL the agent wants to download is covered by the run's allowed
 * set: the exact URL, or any URL on the same site (see {@link canonicalHost}).
 * Same-site (not exact-only) because the agent must be free to normalize a
 * share link or pick the site's canonical watch URL for the same content.
 */
export function isUrlInDownloadScope(url: string, allowed: string[]): boolean {
  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return false;
  }
  for (const one of allowed) {
    if (one === url) return true;
    try {
      if (canonicalHost(new URL(one).hostname) === canonicalHost(candidate.hostname)) return true;
    } catch {
      // an unparsable allow-list entry covers nothing
    }
  }
  return false;
}
