import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testImages } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the image role, returning the configured model and how many models the
 * endpoint serves. Backs the "Test image endpoint" action on the settings form.
 * Checks the model is actually served rather than generating a picture — see
 * `probeImages` for why a real generation is the wrong probe here.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testImages(input, { kind: "dashboard" }));
});
