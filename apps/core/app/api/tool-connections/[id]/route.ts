import { updateToolConnectionSchema } from "@/features/tool-connections/server/schema";
import {
  editToolConnection,
  removeToolConnection,
} from "@/features/tool-connections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-connection API. Thin handlers: the service owns validation, the
 * managed-connection rules, persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateToolConnectionSchema);
  return ok(await editToolConnection(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeToolConnection(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
