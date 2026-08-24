import { updateAssistantSchema } from "@/features/assistants/server/schema";
import { editAssistant, removeAssistant } from "@/features/assistants/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-assistant API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence, trace recording, and the
 * `assistant.deleted` lifecycle event.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateAssistantSchema);
  return ok(await editAssistant(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeAssistant(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
