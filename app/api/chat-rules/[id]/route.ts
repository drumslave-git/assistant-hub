import { updateChatRuleSchema } from "@/features/chat-rules/server/schema";
import { editChatRule, removeChatRule } from "@/features/chat-rules/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Single-rule API. Thin handlers: shared wrappers own validation and error
 * mapping; the service owns persistence and trace recording.
 */
export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, updateChatRuleSchema);
  return ok(await editChatRule(params.id, input, { kind: "dashboard" }));
});

export const DELETE = defineRoute(async ({ params }) => {
  await removeChatRule(params.id, { kind: "dashboard" });
  return ok({ deleted: true });
});
