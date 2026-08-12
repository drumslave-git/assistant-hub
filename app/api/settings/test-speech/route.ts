import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testSpeech } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the speech role, returning the configured model and how many models
 * the endpoint serves. Backs the "Test speech endpoint" action on the settings
 * form. Checks the model is actually served rather than synthesizing audio — see
 * `probeSpeech` for why a real synthesis is the wrong probe here.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testSpeech(input, { kind: "dashboard" }));
});
