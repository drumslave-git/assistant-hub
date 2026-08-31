import { createAssistantSchema } from "@/features/assistants/server/schema";
import { createAssistant, getAssistants } from "@/features/assistants/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Assistants collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording.
 */
// Listing is account-level: the web chat's new-thread picker needs it. The
// user-ownership slice (Phase 9) scopes what a user account sees here.
export const GET = defineRoute(async () => ok({ assistants: await getAssistants() }), {
  access: "account",
});

export const POST = defineRoute(async ({ request, account }) => {
  const input = await parseJson(request, createAssistantSchema);
  // The creator owns the assistant (Phase 8 owner rights).
  return ok(await createAssistant(input, { kind: "dashboard" }, account), { status: 201 });
});
