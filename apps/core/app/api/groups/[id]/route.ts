import {
  updateGroupLanguageSchema,
  updateGroupNotesSchema,
} from "@/features/known-groups/server/schema";
import { updateLanguage, updateNotes } from "@/features/known-groups/server/service";
import { defineRoute, ok, readJsonBody } from "@/server/http";

/**
 * Update a known group's operator-curated fields. Thin handler: shared wrappers
 * own validation and error mapping; the service owns persistence and trace
 * recording. The dashboard saves each field on its own, so the body carries one
 * of `language` or `notes` and is dispatched to the matching traced action.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const raw = await readJsonBody(request);
  if (raw && typeof raw === "object" && "language" in raw) {
    const input = updateGroupLanguageSchema.parse(raw);
    return ok(await updateLanguage(params.id, input, { kind: "dashboard" }));
  }
  const input = updateGroupNotesSchema.parse(raw);
  return ok(await updateNotes(params.id, input, { kind: "dashboard" }));
});
