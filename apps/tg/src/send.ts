import { recordAssistantMessage, type CrossFeed } from "./cross-feed";
import type { TgDb } from "./db";
import type { TgOutbound } from "./outbound";
import { filterMirroredMessageIds } from "./store";
import { findMessageRefs } from "./telegram";

/**
 * Sending one text message into a Telegram chat, as one assistant, with
 * everything that has to happen around it: `#id` references turned into real
 * links only where the target is actually mirrored, the send itself, and the
 * mirror row (which is also what feeds the chat's other assistants).
 *
 * One function because there are two callers who must not drift apart: the
 * internal REST API, which the core uses for sends it decides itself, and this
 * app's MCP `send_message` / `reply_to_message` tools, which the model calls
 * inside a turn.
 */

export interface SendChatMessageInput {
  db: TgDb;
  sender: TgOutbound;
  crossFeed?: CrossFeed;
  chatId: string;
  assistantId: string | null;
  text: string;
  /** What to attach the message to; Telegram may refuse and send it loose. */
  replyToMessageId?: number | null;
  threadId?: number | null;
  silent?: boolean;
}

export interface SentChatMessage {
  messageId: number;
  /** What Telegram actually attached, which is not always what was asked. */
  replyToMessageId: number | null;
}

export async function sendChatMessage(input: SendChatMessageInput): Promise<SentChatMessage> {
  const linkableMessageIds = await filterMirroredMessageIds(
    input.db,
    input.chatId,
    findMessageRefs(input.text),
    input.assistantId,
  ).catch(() => []);

  const sent = await input.sender.sendMessage(input.chatId, input.text, {
    replyToMessageId: input.replyToMessageId ?? null,
    threadId: input.threadId ?? null,
    silent: input.silent ?? false,
    linkableMessageIds,
  });

  await recordAssistantMessage(
    input.db,
    {
      chatId: input.chatId,
      assistantId: input.assistantId,
      telegramMessageId: sent.messageId,
      content: input.text,
      replyToMessageId: sent.replyToMessageId,
      sentAt: new Date(),
      threadId: input.threadId ?? null,
      silent: input.silent ?? false,
    },
    input.crossFeed,
  ).catch(() => null);

  return { messageId: sent.messageId, replyToMessageId: sent.replyToMessageId };
}
