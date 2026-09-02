import { sourceIdSchema } from "@assistant-hub-swarm/contracts";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import { defineRoute, ok, parseJson } from "@/server/http";
import { previewConfig, putTransportConfig } from "@/server/transports/service";

/** The operator's transport-level settings write (owner identity, etc.). */

const putSchema = z.object({ config: z.record(z.string(), z.unknown()) });

export const PUT = defineRoute(async ({ request, params }) => {
  const transport = sourceIdSchema.safeParse(params.id);
  if (!transport.success) throw ApiError.badRequest("unknown transport");
  const input = await parseJson(request, putSchema);
  const row = await putTransportConfig(transport.data, input.config, { kind: "dashboard" });
  return ok({ configPreview: previewConfig(row.config, row.transportConfigSchema) });
});
