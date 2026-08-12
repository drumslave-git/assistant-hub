import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testVision } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the vision role by describing a tiny generated image — a real vision
 * completion, since a model listing cannot say whether a model accepts image
 * input. Backs the "Test vision" action on the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testVision(input, { kind: "dashboard" }));
});
