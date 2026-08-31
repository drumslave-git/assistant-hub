import { updateAssistantSchema } from "@/features/assistants/server/schema";
import { editAssistant, removeAssistant } from "@/features/assistants/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";
import { requireAssistantOwnership } from "@/server/ownership";

/**
 * Single-assistant API. Thin handlers: shared wrappers own validation and
 * error mapping; the service owns persistence, trace recording, and the
 * `assistant.deleted` lifecycle event. Account level since Phase 9, gated
 * by ownership — a user-role account edits and deletes only its own.
 */
export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    await requireAssistantOwnership(account, params.id);
    const input = await parseJson(request, updateAssistantSchema);
    return ok(await editAssistant(params.id, input, { kind: "dashboard" }));
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await requireAssistantOwnership(account, params.id);
    await removeAssistant(params.id, { kind: "dashboard" });
    return ok({ deleted: true });
  },
  { access: "account" },
);
