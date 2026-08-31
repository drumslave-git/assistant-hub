import { createAccountSchema } from "@/features/accounts/schema";
import { createAccount, listAccountViews } from "@/features/accounts/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Account management collection (admin-only, the default access): list every
 * account, create one with a temporary password. Thin handlers — the service
 * owns the guards and the trace record.
 */
export const GET = defineRoute(async () => ok({ accounts: await listAccountViews() }));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createAccountSchema);
  return ok({ account: await createAccount(input, { kind: "dashboard" }) }, { status: 201 });
});
