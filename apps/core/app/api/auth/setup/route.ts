import { z } from "zod";

import { setupOperator, sessionCookie, MIN_PASSWORD_LENGTH } from "@/server/auth";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * First-run operator setup: stores the password (hashed) and opens a session.
 * Public by necessity — it exists exactly when no credential exists yet — and
 * self-sealing: the service refuses to overwrite an already-set password.
 */
const setupSchema = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH) });

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, setupSchema);
  const { token } = await setupOperator(input.password, { kind: "dashboard" });
  return ok({ ok: true }, { headers: { "set-cookie": sessionCookie(token) } });
}, { auth: false });
