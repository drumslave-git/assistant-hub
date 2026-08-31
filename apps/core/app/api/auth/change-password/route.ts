import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { changeAccountPassword, sessionCookie } from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Authenticated password change for the acting account. Session-gated like
 * every other route, and the service additionally demands the current
 * password. The response carries a fresh session cookie: the change rotates
 * the account's session secret (signing out its other sessions), and without
 * a new cookie the caller would be signed out too. This is also where a
 * temporary password (admin-created account) is replaced — the change clears
 * the forced-change hold.
 */
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(1),
});

export const POST = defineRoute(
  async ({ request, account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to change the password");
    const input = await parseJson(request, changePasswordSchema);
    const { token } = await changeAccountPassword(
      account.id,
      input.currentPassword,
      input.newPassword,
      { kind: "dashboard" },
    );
    return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
  },
  // Any account may change its own password — including one still holding
  // its admin-issued temporary password (this is where it gets replaced).
  { access: "account", allowTemporaryPassword: true },
);
