import { testBackendSchema } from "@/features/backends/server/schema";
import { testBackend } from "@/features/backends/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Test a backend connection (stored or as-typed in the form) by listing its
 * models — one call proves the host answers and the key is accepted, and the
 * returned ids are the model preview the Backends page shows.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testBackendSchema);
  return ok(await testBackend(input, { kind: "dashboard" }));
});
