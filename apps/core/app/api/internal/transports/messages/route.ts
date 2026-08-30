import { sourceIdSchema } from "@assistant-hub/contracts";
import { INTERNAL_TOKEN_HEADER } from "@assistant-hub/service";

import { getEnv } from "@/server/env";
import { getSourceMessage } from "@/server/source-store/repository";

/**
 * A transport-side tool asking the mirror about one message — the reaction
 * tool's pre-check (does the target exist, and is it the bot's own?). The
 * mirror lives in the core since Phase 7; the tool's refusal wordings stay
 * with the tool. Token-authenticated like every transport surface.
 */
export async function GET(request: Request): Promise<Response> {
  const token = getEnv().INTERNAL_API_TOKEN;
  if (!token || request.headers.get(INTERNAL_TOKEN_HEADER) !== token) {
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  }
  const url = new URL(request.url);
  const source = sourceIdSchema.safeParse(url.searchParams.get("source"));
  const chatId = url.searchParams.get("chatId");
  const sourceMessageId = url.searchParams.get("sourceMessageId");
  const assistantId = url.searchParams.get("assistantId");
  const direct = url.searchParams.get("direct") === "true";
  if (!source.success || !chatId || !sourceMessageId) {
    return Response.json(
      { error: { message: "source, chatId and sourceMessageId are required" } },
      { status: 400 },
    );
  }
  const row = await getSourceMessage(
    { source: source.data, chatId, assistantId: assistantId || null, direct },
    sourceMessageId,
  );
  return Response.json({
    found: row != null,
    role: row ? (row.role === "assistant" ? "assistant" : "user") : null,
    assistantId: row?.assistantId ?? null,
  });
}
