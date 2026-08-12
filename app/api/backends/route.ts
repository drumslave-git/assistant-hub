import { createBackendSchema } from "@/features/backends/server/schema";
import { createBackend, getBackends } from "@/features/backends/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Backends catalog API. Thin handlers: shared wrappers own validation and error
 * mapping; the service owns persistence, secret masking, and trace recording.
 */

export const GET = defineRoute(async () => ok(await getBackends()));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createBackendSchema);
  return ok(await createBackend(input, { kind: "dashboard" }));
});
