import { updateSpecialistSchema } from "@/features/specialists/server/schema";
import { editSpecialist, removeSpecialist } from "@/features/specialists/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-specialist API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateSpecialistSchema);
  return ok(await editSpecialist(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeSpecialist(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
