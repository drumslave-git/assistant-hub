import { testRoleConnectionSchema } from "@/features/settings/server/schema";
import { testChat } from "@/features/settings/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Probe the chat (main) role by completing a short prompt, reporting the reply
 * and the reasoning behind it — a model listing says nothing about whether the
 * selected model answers, or thinks. Backs the "Test chat" action on the
 * settings form.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, testRoleConnectionSchema);
  return ok(await testChat(input, { kind: "dashboard" }));
});
