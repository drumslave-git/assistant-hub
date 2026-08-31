import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import { createChatThread, listChatThreads } from "@/features/web-chat/server/service";

/**
 * Web-chat threads: the dashboard surface over the web-chat feature service
 * (in-process since the chat dissolve, Phase 6). Thin by design — the
 * service owns the store and the business rules; this layer adds the
 * session and the request shapes. `access: "account"` — the web chat is
 * every account's surface, not an admin tool (Phase 8); per-account thread
 * ownership lands with the web-chat-on-accounts slice.
 */

/**
 * A name is optional: a chat starts nameless and the core names it from the
 * first exchange (`server/turn/name-conversation.ts`), so the browser sends
 * only which assistant it is with.
 */
const createSchema = z.object({
  assistantId: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

export const GET = defineRoute(async () => {
  return ok({ threads: await listChatThreads() });
}, { access: "account" });

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createSchema);
  return ok({ thread: await createChatThread(input) });
}, { access: "account" });
