import {
  messageDedupeKey,
  type MessageDeliveredEvent,
} from "@assistant-hub/contracts";

import { runningRoster, type AssistantConnection } from "./connections";
import type { TgOutbound } from "./outbound";
import { updateEnvelope, type UpdatePublisher } from "./updates";

/**
 * Sending one text message into a Telegram chat, as one assistant: the send
 * itself, then the `message.delivered` event the core's ingest mirrors and
 * cross-feeds. One function because there are two callers who must not drift
 * apart: the internal REST API and this app's MCP delivery tools.
 *
 * `#id` links: the whitelist arrives from the CORE (it owns the mirror since
 * Phase 7) — callers pass what the reply-delivery event or the send request
 * carried; nothing is resolved here.
 */

export interface SendDeps {
  sender: TgOutbound;
  publisher: UpdatePublisher;
  running: () => AssistantConnection[];
}

export interface SendChatMessageInput {
  chatId: string;
  assistantId: string | null;
  text: string;
  /** What to attach the message to; Telegram may refuse and send it loose. */
  replyToMessageId?: number | null;
  threadId?: number | null;
  silent?: boolean;
  /** Core-resolved whitelist for `#<id>` citation links. */
  linkableMessageIds?: readonly number[];
}

export interface SentChatMessage {
  messageId: number;
  /** What Telegram actually attached, which is not always what was asked. */
  replyToMessageId: number | null;
}

/** Whether a telegram chat id names a group (negative ids). */
export function isGroupChat(chatId: string): boolean {
  return chatId.startsWith("-");
}

/** Report one performed delivery to the core (mirror + cross-feed seam). */
export async function publishDelivered(
  deps: Pick<SendDeps, "publisher" | "running">,
  input: {
    chatId: string;
    assistantId: string | null;
    messageId: number;
    content: string;
    replyToMessageId: number | null;
    threadId?: number | null;
    silent?: boolean;
    image?: { fileId: string; fileUniqueId: string | null; base64: string } | null;
  },
): Promise<void> {
  const isGroup = isGroupChat(input.chatId);
  const event: MessageDeliveredEvent = {
    ...updateEnvelope(`${input.chatId}:${input.messageId}`),
    type: "message.delivered",
    source: "tg",
    chat: { id: input.chatId, kind: isGroup ? "group" : "direct" },
    assistantId: input.assistantId,
    sourceMessageId: String(input.messageId),
    dedupeKey: messageDedupeKey({
      chatId: input.chatId,
      sourceMessageId: String(input.messageId),
      assistantId: isGroup ? null : input.assistantId,
    }),
    content: input.content,
    replyToSourceMessageId:
      input.replyToMessageId != null ? String(input.replyToMessageId) : null,
    sentAt: new Date().toISOString(),
    threadId: input.threadId != null ? String(input.threadId) : null,
    silent: input.silent ?? false,
    image: input.image ?? null,
    running: runningRoster(deps.running()),
  };
  await deps.publisher.publish(event);
}

export async function sendChatMessage(
  deps: SendDeps,
  input: SendChatMessageInput,
): Promise<SentChatMessage> {
  const sent = await deps.sender.sendMessage(input.chatId, input.text, {
    replyToMessageId: input.replyToMessageId ?? null,
    threadId: input.threadId ?? null,
    silent: input.silent ?? false,
    linkableMessageIds: input.linkableMessageIds ?? [],
  });

  await publishDelivered(deps, {
    chatId: input.chatId,
    assistantId: input.assistantId,
    messageId: sent.messageId,
    content: input.text,
    // What is actually in the chat, not what was asked for.
    replyToMessageId: sent.replyToMessageId,
    threadId: input.threadId,
    silent: input.silent,
  }).catch((err) => {
    console.error(
      `Failed to report delivery ${input.chatId}:${sent.messageId}:`,
      err instanceof Error ? err.message : String(err),
    );
  });

  return { messageId: sent.messageId, replyToMessageId: sent.replyToMessageId };
}
