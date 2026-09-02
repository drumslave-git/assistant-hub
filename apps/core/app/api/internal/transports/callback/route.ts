import { transportCallbackRequestSchema } from "@assistant-hub-swarm/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub-swarm/service";

import { processCallbackPress } from "@/features/self-improvement/server/collect-flows";
import { collectTransport } from "@/features/self-improvement/server/collect-transport";
import { getEnv } from "@/server/env";

/**
 * A feedback-menu button press, POSTed by the owning transport
 * *synchronously* (redesign Phase 7): the platform's button spinner wants an
 * answer only the flow's outcome can word, so this is the one transport
 * update that is a request/response rather than a queue event. The
 * transport answers the callback query with the returned toast.
 *
 * Authenticated by the shared internal token — this surface belongs to the
 * transports, not to an operator session.
 */
export async function POST(request: Request): Promise<Response> {
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token || request.headers.get(INTERNAL_TOKEN_HEADER) !== token) {
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  }
  const parsed = transportCallbackRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return Response.json({ error: { message: "a callback request is required" } }, { status: 400 });
  }
  const body = parsed.data;
  const transport = collectTransport(body.source);
  if (!transport) {
    return Response.json({ toast: null });
  }
  try {
    const { toast } = await processCallbackPress(
      {
        data: body.data,
        presserUserId: body.user.userId,
        chatId: body.chat.id,
        menuSourceMessageId: body.menuSourceMessageId,
      },
      { source: body.source, assistantId: body.assistantId, transport },
    );
    return Response.json({ toast });
  } catch (err) {
    console.error(
      "feedback callback processing failed:",
      err instanceof Error ? err.message : String(err),
    );
    return Response.json({ toast: null });
  }
}
