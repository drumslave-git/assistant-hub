import { z } from "zod";

import { unlinkOwnIdentity } from "@/features/accounts/server/profile";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Unlink one of the acting account's OWN platform identities — the undo for
 * redeeming a link code. The service refuses refs that are not this account's
 * and refuses its own web identity; admins edit anyone's links on the Users
 * page instead.
 */
const deleteSchema = z.object({ ref: z.string().min(1) });

export const DELETE = defineRoute(
  async ({ request, account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to manage your identities");
    const { ref } = parseQuery(request, deleteSchema);
    return ok(await unlinkOwnIdentity(account.id, ref, { kind: "dashboard" }));
  },
  { access: "account" },
);
