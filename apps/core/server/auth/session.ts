import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless operator sessions: the cookie value is `<expiresMs>.<nonce>.<sig>`
 * where `sig` = HMAC-SHA256 over the first two parts, keyed by the DB-stored
 * session secret. No session table — a token is valid iff its signature checks
 * out and it has not expired, and rotating the secret (a new setup) invalidates
 * everything at once.
 */

import { SESSION_COOKIE } from "@/lib/auth";

export { SESSION_COOKIE };

/** Session lifetime. A code constant, not a setting. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Mint a session token valid for {@link SESSION_TTL_MS} from `now`. */
export function mintSessionToken(secret: string, now: Date = new Date()): string {
  const payload = `${now.getTime() + SESSION_TTL_MS}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** Whether a token is authentic (signature) and current (expiry). */
export function verifySessionToken(
  secret: string,
  token: string,
  now: Date = new Date(),
): boolean {
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const payload = token.slice(0, lastDot);
  const sig = Buffer.from(token.slice(lastDot + 1));
  const expected = Buffer.from(sign(payload, secret));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return false;
  const expiresMs = Number(payload.split(".")[0]);
  return Number.isFinite(expiresMs) && expiresMs > now.getTime();
}

/**
 * Cookie attributes for the session. `Secure` is deliberately omitted: the
 * self-hosted dashboard commonly runs over plain HTTP on a LAN, and behind a
 * TLS proxy the cookie is transported encrypted anyway.
 */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}`;
}

/** An expired cookie header value — the logout. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Extract the session token from a `Cookie` request header, or null. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim() || null;
  }
  return null;
}
