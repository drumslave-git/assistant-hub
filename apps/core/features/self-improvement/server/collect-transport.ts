import "server-only";

import {
  internalSentMenuResponseSchema,
  type SourceId,
} from "@assistant-hub-swarm/contracts";

import { internalRequester, sourceApiConfig } from "@/server/source/internal-client";

import type { CollectTransport } from "./collect-flows";

/**
 * The menu operations over the owning transport's internal API — how the
 * core-owned feedback flow posts, edits and removes its option menus in the
 * platform chat. Which app answers is resolved from the source id, as every
 * other transport call is.
 */

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The menu transport for one source, or null for the web chat (no reactions
 * there). Config resolves per call from the transport's registration; an
 * unregistered transport's calls fail audibly and the flows degrade.
 */
export function collectTransport(source: SourceId): CollectTransport | null {
  if (source === "chat") return null;
  const request = internalRequester({
    config: () => sourceApiConfig(source),
    label: `${source} internal API`,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const menuPath = (chatId: string, rest = "") =>
    `/internal/chats/${encodeURIComponent(chatId)}/menu${rest}`;

  return {
    async sendMenu(input) {
      const body = internalSentMenuResponseSchema.parse(
        await request(`${menuPath(input.chatId)}?assistantId=${encodeURIComponent(input.assistantId)}`, {
          method: "POST",
          body: JSON.stringify({
            text: input.text,
            keyboard: input.keyboard,
            replyToSourceMessageId: input.replyToSourceMessageId,
          }),
        }),
      );
      return { sourceMessageId: body.sourceMessageId };
    },
    async editMenu(input) {
      await request(
        `${menuPath(input.chatId, `/${encodeURIComponent(input.sourceMessageId)}`)}?assistantId=${encodeURIComponent(input.assistantId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ text: input.text, keyboard: input.keyboard }),
        },
      );
    },
    async deleteMenu(input) {
      await request(
        `${menuPath(input.chatId, `/${encodeURIComponent(input.sourceMessageId)}`)}?assistantId=${encodeURIComponent(input.assistantId)}`,
        { method: "DELETE" },
      );
    },
  };
}
