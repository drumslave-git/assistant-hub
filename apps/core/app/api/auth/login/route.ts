import { z } from "zod";

import { loginAccount, sessionCookie } from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/** Account login: verify username + password, open a session. Public by necessity. */
const loginSchema = z.object({
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, loginSchema);
  const { token } = await loginAccount(input, { kind: "dashboard" });
  return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}, { access: "public" });
