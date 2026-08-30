import { transportRegistrationRequestSchema } from "@assistant-hub/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub/service";

import { reconcileManagedConnections } from "@/features/tool-connections/server/managed";
import { getEnv } from "@/server/env";
import { registerTransport } from "@/server/transports/service";

/**
 * Transport self-registration (PLAN.md "The transport contract"): a
 * transport announces itself at boot and receives its desired state in the
 * same round trip. Adding a transport to a running core is deploying one
 * container that calls this — no core change.
 */
export async function POST(request: Request): Promise<Response> {
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token || request.headers.get(INTERNAL_TOKEN_HEADER) !== token) {
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  }
  const parsed = transportRegistrationRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json(
      { error: { message: "a transport registration is required" } },
      { status: 400 },
    );
  }
  const desired = await registerTransport(parsed.data);
  console.log(`transport '${parsed.data.id}' registered from ${parsed.data.baseUrl}`);
  // The transport's MCP server just became reachable (or moved): bring its
  // managed tool connection and snapshot in line without waiting for a core
  // restart. Detached — registration must answer promptly.
  void reconcileManagedConnections().catch((err) => {
    console.error("managed reconcile after registration failed:", err);
  });
  return Response.json(desired);
}
