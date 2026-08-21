import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testClassifier } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the classifier role by running the real addressing check over a
 * synthetic message — a model listing cannot say whether a model answers a
 * classification quickly and in a shape the verdict parser accepts, which is
 * the only thing this role does. Backs "Test classifier model".
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testClassifier(input, { kind: "dashboard" }));
});
