import { createAssistantSchema } from "@/features/assistants/server/schema";
import { createAssistant, getAssistants } from "@/features/assistants/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Assistants collection API. Thin handlers: the service owns validation,
 * persistence, and trace recording.
 */
export const GET = defineRoute(async () => ok({ assistants: await getAssistants() }));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createAssistantSchema);
  return ok(await createAssistant(input, { kind: "dashboard" }), { status: 201 });
});
