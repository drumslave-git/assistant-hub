import { setChatSpecialistSchema } from "@/features/specialists/server/schema";
import { setChatSpecialist } from "@/features/specialists/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Per-chat specialist assignment API (dashboard side of activation). `PUT` sets
 * or clears one chat's active specialist; the chat-side switch goes through the
 * MCP tool with its own permission gate.
 */
export const PUT = defineRoute(async ({ request }) => {
  const input = await parseJson(request, setChatSpecialistSchema);
  return ok(
    await setChatSpecialist(
      { chatId: input.chatId, specialistId: input.specialistId },
      { kind: "dashboard" },
    ),
  );
});
