import { updateGeneralMemorySchema } from "@/features/memory/server/schema";
import { editGeneralMemory, forgetGeneralMemory } from "@/features/memory/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * General-knowledge API. Thin handler: shared wrappers own validation and error
 * mapping; the service owns persistence and trace recording. (Reads come from the
 * aggregate view at `GET /api/memory`.)
 *
 * No id in the path and no POST: general knowledge is ONE document, so writing it
 * is an upsert — the first edit creates it — and there is nothing to address
 * individually. It replaces the former `POST /api/memory/general` +
 * `PATCH|DELETE /api/memory/general/[id]`, which existed when the scope was a set
 * of independently stored facts.
 */
export const PATCH = defineRoute(async ({ request }) => {
  const input = await parseJson(request, updateGeneralMemorySchema);
  return ok(await editGeneralMemory(input));
});

export const DELETE = defineRoute(async () => {
  await forgetGeneralMemory();
  return ok({ deleted: true });
});
