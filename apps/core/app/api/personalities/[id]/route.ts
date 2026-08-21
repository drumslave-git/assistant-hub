import { updatePersonalitySchema } from "@/features/personalities/server/schema";
import { editPersonality, removePersonality } from "@/features/personalities/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-personality API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updatePersonalitySchema);
  return ok(await editPersonality(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removePersonality(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
