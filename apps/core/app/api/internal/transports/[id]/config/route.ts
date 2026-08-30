import { sourceIdSchema } from "@assistant-hub/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub/service";
import { z } from "zod";

import { isApiError } from "@/lib/api-error";
import { getEnv } from "@/server/env";
import { mergeTransportConfig } from "@/server/transports/service";

const patchSchema = z.record(z.string(), z.unknown());

/**
 * A transport writing back into its own config blob (telegram persisting the
 * owner id it just resolved). Shallow merge — the keys are the transport's.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token || request.headers.get(INTERNAL_TOKEN_HEADER) !== token) {
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  }
  const id = sourceIdSchema.safeParse((await context.params).id);
  if (!id.success) {
    return Response.json({ error: { message: "unknown transport" } }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: { message: "a config patch is required" } }, { status: 400 });
  }
  try {
    const row = await mergeTransportConfig(id.data, parsed.data);
    return Response.json({ config: row.config });
  } catch (err) {
    if (isApiError(err)) {
      return Response.json({ error: { message: err.message } }, { status: err.status });
    }
    throw err;
  }
}
