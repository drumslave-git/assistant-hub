import { createChatRuleSchema } from "@/features/chat-rules/server/schema";
import { createChatRule, getChatRulesView } from "@/features/chat-rules/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Chat-rules collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording. The dashboard is operator-only, so it may
 * author any scope — including the global one a chat cannot write.
 */
export const GET = defineRoute(async () => ok(await getChatRulesView()));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createChatRuleSchema);
  return ok(await createChatRule(input, { kind: "dashboard" }), { status: 201 });
});
