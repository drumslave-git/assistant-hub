import { defineRoute, ok } from "@/server/http";
import { listChatThreads } from "@/server/source/chat-operator";

/**
 * Web-chat threads proxy: the dashboard surface over the chat source app's
 * operator API. Thin by design — the source owns its store and its
 * validation; this layer adds the operator session and relays the source's
 * verdicts.
 */
export const GET = defineRoute(async () => {
  return ok({ threads: await listChatThreads() });
});
