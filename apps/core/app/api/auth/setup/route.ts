import { z } from "zod";

import {
  setupFirstAdmin,
  sessionCookie,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
} from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * First-run setup: create the first admin account and open its session.
 * Public by necessity — it exists exactly when no account exists yet — and
 * self-sealing: the service refuses to run once any account exists.
 */
const setupSchema = z.object({
  username: z.string().trim().min(MIN_USERNAME_LENGTH),
  password: z.string().min(MIN_PASSWORD_LENGTH),
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, setupSchema);
  const { token } = await setupFirstAdmin(input, { kind: "dashboard" });
  return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}, { access: "public" });
