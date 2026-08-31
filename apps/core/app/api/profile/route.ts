import { z } from "zod";

import {
  getProfileIdentities,
  getProfileMemory,
  updateOwnDisplayName,
} from "@/features/accounts/server/profile";
import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * The acting account's profile (Phase 8): who they are, their linked
 * identities, and the memory held about them. Account-level — every role
 * has a profile; everything is scoped to the session's own account.
 */
export const GET = defineRoute(
  async ({ account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to see your profile");
    const [identities, memory] = await Promise.all([
      getProfileIdentities(account.id),
      getProfileMemory(account.id),
    ]);
    return ok({
      account: {
        id: account.id,
        username: account.username,
        displayName: account.displayName,
        role: account.role,
      },
      identities,
      memory,
    });
  },
  { access: "account" },
);

const patchSchema = z.object({ displayName: z.string().max(120) });

export const PATCH = defineRoute(
  async ({ request, account }) => {
    if (!account) throw ApiError.unauthorized("Sign in to edit your profile");
    const input = await parseJson(request, patchSchema);
    return ok(await updateOwnDisplayName(account.id, input.displayName, { kind: "dashboard" }));
  },
  { access: "account" },
);
