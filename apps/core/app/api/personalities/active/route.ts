import { setActivePersonalitySchema } from "@/features/personalities/server/schema";
import { setActivePersonality } from "@/features/personalities/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Active-personality selection API. `PUT` sets (or clears, with null) which
 * personality is active. Thin handler: the service validates and traces.
 */
export const PUT = defineRoute(async ({ request }) => {
  const { personalityId } = await parseJson(request, setActivePersonalitySchema);
  return ok(await setActivePersonality(personalityId, { kind: "dashboard" }));
});
