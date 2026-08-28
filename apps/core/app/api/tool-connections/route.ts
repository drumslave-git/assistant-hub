import { createToolConnectionSchema } from "@/features/tool-connections/server/schema";
import {
  createToolConnection,
  getToolConnections,
} from "@/features/tool-connections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Tool-connections collection API. Thin handlers: the service owns
 * validation, persistence, secret masking and trace recording.
 */
export const GET = defineRoute(async () => ok({ connections: await getToolConnections() }));

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createToolConnectionSchema);
  return ok(await createToolConnection(input, { kind: "dashboard" }), { status: 201 });
});
