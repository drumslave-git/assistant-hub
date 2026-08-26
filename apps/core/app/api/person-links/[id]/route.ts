import { updatePersonLinkSchema } from "@/features/person-links/server/schema";
import { editLink, removeLink } from "@/features/person-links/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-person-link API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence and trace recording. The
 * dashboard saves the note and the identity list on their own, so the body
 * carries one of them.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updatePersonLinkSchema);
  return ok(await editLink(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeLink(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
