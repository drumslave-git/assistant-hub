import { z } from "zod";

import { changeOperatorPassword, sessionCookie } from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Authenticated password change. Session-gated like every other route, and the
 * service additionally demands the current password. The response carries a
 * fresh session cookie: the change rotates the session secret (signing out every
 * other session), and without a new cookie the caller would be signed out too.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, changePasswordSchema);
  const { token } = await changeOperatorPassword(input.currentPassword, input.newPassword, {
    kind: "dashboard",
  });
  return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
});
