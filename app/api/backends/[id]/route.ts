import { updateBackendSchema } from "@/features/backends/server/schema";
import { editBackend, removeBackend } from "@/features/backends/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-backend API. Thin handlers: shared wrappers own validation and error
 * mapping; the service owns persistence, the in-use delete guard, and trace
 * recording (including stale-model clearing when a URL change repoints roles).
 */

export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateBackendSchema);
  return ok(await editBackend(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeBackend(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
