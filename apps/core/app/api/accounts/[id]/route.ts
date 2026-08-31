import { patchAccountSchema } from "@/features/accounts/schema";
import { patchAccount } from "@/features/accounts/server/service";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * One account's management actions (admin-only): activate/deactivate, role
 * change, fresh temporary password. One action per call; the service owns
 * the self-lockout and last-admin guards.
 */
export const PATCH = defineRoute(async ({ request, params, account }) => {
  // Admin access guarantees an account outside the unconfigured window.
  if (!account) throw ApiError.unauthorized("Sign in to manage accounts");
  const patch = await parseJson(request, patchAccountSchema);
  return ok({
    account: await patchAccount(params.id, patch, { id: account.id }, { kind: "dashboard" }),
  });
});
