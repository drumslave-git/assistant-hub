import { sourceIdSchema } from "@assistant-hub-swarm/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub-swarm/service";

import { isApiError } from "@/lib/api-error";
import { getEnv } from "@/server/env";
import { desiredTransportState } from "@/server/transports/service";

/** A transport refetching its desired state (on `transport.config.changed`). */
export async function GET(
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
  try {
    return Response.json(await desiredTransportState(id.data));
  } catch (err) {
    if (isApiError(err)) {
      return Response.json({ error: { message: err.message } }, { status: err.status });
    }
    throw err;
  }
}
