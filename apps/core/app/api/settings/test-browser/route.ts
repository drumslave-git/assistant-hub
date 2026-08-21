import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testBrowser } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the browser-agent role by running one real tool round — a model listing
 * cannot say whether a model supports tool calling, which is all the browser
 * agent does. Backs the "Test browser model" action on the settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testBrowser(input, { kind: "dashboard" }));
});
