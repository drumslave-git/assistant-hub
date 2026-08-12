import { listSectionModelsSchema } from "@/features/settings/server/schema";
import { listSectionModels } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * List the models served by a section endpoint as currently entered in the
 * settings form (saved or not). Backs the model dropdown refresh when the
 * operator repoints a section at a different host.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, listSectionModelsSchema);
  return ok(await listSectionModels(input));
});
