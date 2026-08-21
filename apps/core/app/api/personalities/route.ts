import { createPersonalitySchema } from "@/features/personalities/server/schema";
import { createPersonality, getPersonalitiesView } from "@/features/personalities/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Personalities collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording.
 */
export const GET = defineRoute(async () => ok(await getPersonalitiesView()));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createPersonalitySchema);
  return ok(await createPersonality(input, { kind: "dashboard" }), { status: 201 });
});
