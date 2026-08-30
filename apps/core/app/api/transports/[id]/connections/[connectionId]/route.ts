import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import {
  deleteAssistantTransport,
  updateAssistantTransport,
} from "@/server/transports/service";

/** One connection: re-config (shallow merge), start/stop, disconnect. */

const patchSchema = z
  .object({
    config: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((patch) => patch.config !== undefined || patch.enabled !== undefined, {
    message: "config or enabled is required",
  });

export const PATCH = defineRoute(async ({ request, params }) => {
  const input = await parseJson(request, patchSchema);
  const row = await updateAssistantTransport(params.connectionId, input, { kind: "dashboard" });
  return ok({ connection: { id: row.id, enabled: row.enabled } });
});

export const DELETE = defineRoute(async ({ params }) => {
  await deleteAssistantTransport(params.connectionId, { kind: "dashboard" });
  return ok({ deleted: true });
});
