import { z } from "zod";

import { forgetOwnMemory } from "@/features/accounts/server/profile";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Delete one of the acting account's OWN memory documents (view + delete is
 * the whole user-facing memory surface — no self-authoring, PLAN.md). The
 * service refuses keys that are not the account's identities; admins manage
 * everyone's memory on the admin memory page instead.
 */
const deleteSchema = z.object({ userId: z.string().min(1) });

export const DELETE = defineRoute(
  async ({ request, account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to manage your memory");
    const { userId } = parseQuery(request, deleteSchema);
    await forgetOwnMemory(account.id, userId);
    return ok({ deleted: true });
  },
  { access: "account" },
);
