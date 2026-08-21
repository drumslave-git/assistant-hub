import { isIP } from "node:net";

/**
 * SSRF guard for the read-link tool. The model supplies the URL, so before we
 * point a real browser at it we reject anything that could reach the host's own
 * network: non-http(s) schemes, embedded credentials, localhost, the Docker host
 * gateway, and literal private/loopback/link-local IPs. Pure and unit-tested.
 * The DNS half of the defense (re-checking what a hostname actually resolves
 * to, including on redirects) lives at the fetch layer —
 * `server/resolve-safety.ts` — and reuses {@link isPrivateIp}.
 */

/** Whether an IPv4 octet tuple is in a private/loopback/link-local range. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

/** Whether a literal IP host is private/loopback/link-local (IPv4 or IPv6). */
export function isPrivateIp(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) {
    const octets = host.split(".").map((n) => Number.parseInt(n, 10));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) return true;
    return isPrivateIpv4(octets);
  }
  if (kind === 6) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true; // unspecified / loopback
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique-local
    if (h.startsWith("fe80:")) return true; // link-local
    // IPv6-mapped IPv4 (`::ffff:10.0.0.1`) — the shape `dns.lookup` can return
    // for a v4-only host; the embedded v4 address is what must be judged.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateIp(mapped[1]);
  }
  return false;
}

/** Block SSRF targets (bad scheme, credentials, localhost, docker host, private IPs). */
export function isSafePublicUrl(urlStr: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host === "host.docker.internal") return false;

  // WHATWG `URL.hostname` wraps IPv6 literals in brackets (e.g. "[::1]"); strip
  // them so `isIP` recognizes the address.
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bareHost)) return !isPrivateIp(bareHost);

  return true;
}

/** Normalize a raw URL to its canonical http(s) href, or null when unusable. */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
