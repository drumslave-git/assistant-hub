import {
  updateAliasesSchema,
  updateUserLanguageSchema,
} from "@/features/known-users/server/schema";
import { updateAliases, updateLanguage } from "@/features/known-users/server/service";
import { defineRoute, ok, readJsonBody } from "@/server/http";

/**
 * Update a known user's operator-curated fields. Thin handler: shared wrappers
 * own validation and error mapping; the service owns persistence and trace
 * recording. The dashboard saves each field on its own, so the body carries one
 * of `language` or `aliases` and is dispatched to the matching traced action.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const raw = await readJsonBody(request);
  if (raw && typeof raw === "object" && "language" in raw) {
    const input = updateUserLanguageSchema.parse(raw);
    return ok(await updateLanguage(params.id, input, { kind: "dashboard" }));
  }
  const input = updateAliasesSchema.parse(raw);
  return ok(await updateAliases(params.id, input, { kind: "dashboard" }));
});
