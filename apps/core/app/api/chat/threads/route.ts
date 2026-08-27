import { z } from "zod";

import { defineRoute, ok, parseJson } from "@/server/http";
import { createChatThread, listChatThreads } from "@/server/source/chat-operator";

/**
 * Web-chat threads proxy: the dashboard surface over the chat source app's
 * thread API. Thin by design — the source owns its store and its validation;
 * this layer adds the operator session and relays the source's verdicts.
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
});

export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, createSchema);
  return ok({ thread: await createChatThread(input) });
});
