import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import { requireAssistantOwnership } from "@/server/ownership";
import {
  deleteAssistantTransport,
  getAssistantTransportById,
  updateAssistantTransport,
} from "@/server/transports/service";

/** Phase 9 gate: the connection's assistant must be the actor's own. */
async function requireOwnConnection(
  account: { id: string; role: "admin" | "user" } | null,
  connectionId: string,
): Promise<void> {
  const row = await getAssistantTransportById(connectionId);
  if (!row) throw ApiError.notFound("Unknown connection");
  await requireAssistantOwnership(account, row.assistantId);
}

/** One connection: re-config (shallow merge), start/stop, disconnect. */

const patchSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => patch.config !== undefined || patch.enabled !== undefined, {
    message: "config or enabled is required",
  });

export const PATCH = defineRoute(
  async ({ request, params, account }) => {
    await requireOwnConnection(account, params.connectionId);
    const input = await parseJson(request, patchSchema);
    const row = await updateAssistantTransport(params.connectionId, input, { kind: "dashboard" });
    return ok({ connection: { id: row.id, enabled: row.enabled } });
  },
  { access: "account" },
);

export const DELETE = defineRoute(
  async ({ params, account }) => {
    await requireOwnConnection(account, params.connectionId);
    await deleteAssistantTransport(params.connectionId, { kind: "dashboard" });
    return ok({ deleted: true });
  },
  { access: "account" },
);
