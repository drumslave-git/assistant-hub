import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { isPrivateIp } from "../url-safety";

/**
 * The DNS half of the SSRF guard. `isSafePublicUrl` rejects *literal* private
 * addresses before a fetch starts, but a model-supplied hostname can simply
 * resolve to `10.x.x.x` or `169.254.169.254` — so the fetch layer re-checks
 * what the name actually resolves to before (and during, via redirect
 * interception in `playwright.ts`) pointing Chromium at it.
 *
 * Residual gap, accepted: a rebinding server can still answer our lookup with a
 * public address and Chromium's own lookup with a private one (TOCTOU). Closing
 * that needs connect-by-IP pinning, which Playwright does not expose; verdicts
 * are cached per page load to shrink the window and the cost.
 */

/** Injectable resolver (tests); the default is the OS resolver via `dns.lookup`. */
export type LookupAll = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupAll = (hostname) => lookup(hostname, { all: true });

/**
 * Whether a URL hostname is safe to fetch: a public literal IP, or a name whose
 * *every* resolved address is public. Unresolvable names are blocked — the
 * fetch would fail anyway, and "could not verify" must not mean "allowed".
 */
export async function hostResolvesPublic(
  hostname: string,
  cache?: Map<string, boolean>,
  lookupAll: LookupAll = defaultLookup,
): Promise<boolean> {
  const host = hostname.toLowerCase();
  // WHATWG `URL.hostname` wraps IPv6 literals in brackets; strip for `isIP`.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare)) return !isPrivateIp(bare);

  const cached = cache?.get(bare);
  if (cached !== undefined) return cached;

  const addresses = await lookupAll(bare).catch(() => []);
  const ok = addresses.length > 0 && addresses.every((a) => !isPrivateIp(a.address));
  cache?.set(bare, ok);
  return ok;
}
