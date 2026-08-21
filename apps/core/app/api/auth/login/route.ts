import { z } from "zod";

import { loginOperator, sessionCookie } from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/** Operator login: verify the password, open a session. Public by necessity. */
const loginSchema = z.object({ password: z.string().min(1) });

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, loginSchema);
  const { token } = await loginOperator(input.password, { kind: "dashboard" });
  return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}, { auth: false });
