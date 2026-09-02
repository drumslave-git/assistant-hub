import { transportRegistrationRequestSchema } from "@assistant-hub/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub/service";

import { isApiError } from "@/lib/api-error";
import { reconcileManagedConnections } from "@/features/tool-connections/server/managed";
import { getEnv } from "@/server/env";
import { registerTransport } from "@/server/transports/service";

/**
 * Transport self-registration (PLAN.md "The transport contract"): a
 * transport announces itself at boot — any source id it picked — and
 * receives its desired state in the same round trip. Adding a transport to a
 * running core is deploying one container that calls this; the core has no
 * list to extend. The one thing checked is the contract major: a mismatch is
 * registered (so the roster can show why) and refused with 409.
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
  let desired;
  try {
    desired = await registerTransport(parsed.data);
  } catch (err) {
    if (isApiError(err)) {
      console.error(`transport '${parsed.data.id}' refused: ${err.message}`);
      return Response.json({ error: { message: err.message } }, { status: err.status });
    }
    throw err;
  }
  console.log(`transport '${parsed.data.id}' registered from ${parsed.data.baseUrl}`);
  // The transport's MCP server just became reachable (or moved): bring its
  // managed tool connection and snapshot in line without waiting for a core
  // restart. Detached — registration must answer promptly.
  void reconcileManagedConnections().catch((err) => {
    console.error("managed reconcile after registration failed:", err);
  });
  return Response.json(desired);
}
