import { clearedSessionCookie } from "@/server/auth";
import { defineRoute, ok } from "@/server/http";

/**
 * Logout: expire the session cookie. Public — clearing one's own cookie needs
 * no session, and a logout must still work with an already-expired one.
 */
export const POST = defineRoute(async () => {
  return ok({ ok: true }, { headers: { "set-cookie": clearedSessionCookie() } });
}, { auth: false });
