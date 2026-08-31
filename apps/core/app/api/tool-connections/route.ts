import { createToolConnectionSchema } from "@/features/tool-connections/server/schema";
import {
  createToolConnection,
  getToolConnections,
} from "@/features/tool-connections/server/service";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Tool-connections collection API. Thin handlers: the service owns
 * validation, persistence, secret masking and trace recording. Account
 * level since Phase 9: admins see and manage every connection, a user-role
 * account only its own (with the user-connection restrictions enforced by
 * the service).
 */
export const GET = defineRoute(
  async ({ account }) => ok({ connections: await getToolConnections(account) }),
  { access: "account" },
);

export const POST = defineRoute(
  async ({ request, account }) => {
    const input = await parseJson(request, createToolConnectionSchema);
    return ok(await createToolConnection(input, { kind: "dashboard" }, account), { status: 201 });
  },
  { access: "account" },
);
