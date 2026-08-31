import "server-only";

import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/auth";

import { judgeSessionToken, type SessionAccount } from "./service";

/**
 * The acting account for a Server Component (the pages side of what
 * `defineRoute` hands API bodies). Null while auth is unconfigured, the
 * session is invalid, or the database is down — the route-group layouts own
 * the redirects; pages use this only to SCOPE what they render (Phase 9),
 * so null falls back to the unrestricted view the layouts already gate.
 */
export async function actingAccount(): Promise<SessionAccount | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? null;
  const verdict = await judgeSessionToken(token).catch(() => ({ kind: "invalid" }) as const);
  return verdict.kind === "ok" ? verdict.account : null;
}
