import {
  messageDedupeKey,
  transportMessageEventSchema,
  type TransportMessageEvent,
  type TransportReceiver,
  type TransportUpdateEvent,
} from "@assistant-hub-swarm/contracts";
import type { Message } from "@grammyjs/types";

import { checkAddressed } from "./addressing";
import type { AssistantConnection } from "./connections";
import { detectMessageMedia } from "./media/detect";
import { loadMessageMedia, type FileDownloader } from "./media/ingest";
import { updateEnvelope, type SeenCache } from "./updates";

/**
 * Inbound processing, stateless since the Phase 7 de-storing: normalize one
 * Telegram `message` update — media downloaded and normalized here, the
 * per-connection structural addressing verdicts computed here — into ONE
 * transport-update event. The core's ingest persists it, resolves the
 * audience from its presence rows, composes the context, and opens the
 * turns; this app never decides anything about replying.
 *
 * A group message is delivered to EVERY bot in the chat but forwarded once:
 * the in-process seen-cache suppresses the duplicates, which still count as
 * presence evidence (the caller publishes a presence stamp for them).
 */

export type InboundResult =
  | { status: "forwarded"; event: TransportMessageEvent }
  | { status: "duplicate" }
  | { status: "skipped"; reason: "bot_or_anonymous_sender" | "no_content" };

export interface InboundDeps {
  /** The connection (bot) that received the update. */
  assistantId: string;
  /** Numeric Telegram id of the receiving bot (self-detection in quotes). */
  botId: number;
  /** The connection's bot token — media downloads need it. */
  botToken: string;
  /**
   * Every connection running right now, with bot identities — the receivers
   * list carries a structural verdict per each, so the core can fan a group
   * message out without ever reading Telegram's wire format.
   */
  running: () => AssistantConnection[];
  /** The group-update dedupe cache (one per process). */
  seen: SeenCache;
  /** Test seam: fake the Telegram file download. */
  download?: FileDownloader;
}

/** Normalize one incoming Telegram `message` update into its event. */
export async function processIncomingMessage(
  message: Message,
  deps: InboundDeps,
): Promise<InboundResult> {
  const from = message.from;
  const chat = message.chat;
  const chatId = String(chat.id);
  const text = message.text ?? message.caption ?? "";
  const isGroup = chat.type !== "private";

  // Bot-authored messages are never forwarded: an assistant's own reply is
  // reported by the send that made it (`message.delivered`), and reaches the
  // chat's other assistants through the core's cross-feed — not through an
  // update Telegram never sends anyway.
  if (!from || from.is_bot) {
    return { status: "skipped", reason: "bot_or_anonymous_sender" };
  }
  const hasMedia = detectMessageMedia(message) !== null;
  if (!text.trim() && !hasMedia) {
    return { status: "skipped", reason: "no_content" };
  }

  const senderId = String(from.id);
  const dedupeKey = messageDedupeKey({
    chatId,
    sourceMessageId: String(message.message_id),
    // A group is one shared stream; a DM's message ids are per bot.
    assistantId: isGroup ? null : deps.assistantId,
  });
  if (isGroup && !deps.seen.first(`m:${dedupeKey}`)) {
    return { status: "duplicate" };
  }

  const media = hasMedia
    ? await loadMessageMedia({
        token: deps.botToken,
        message,
        download: deps.download,
      }).catch(() => null)
    : null;

  // The structural verdict per running connection — judged against each
  // receiver's own bot account. Direct chats list the receiving connection
  // alone (one person, one bot).
  const connections = isGroup
    ? deps.running()
    : deps.running().filter((c) => c.assistantId === deps.assistantId);
  const receivers: TransportReceiver[] = connections.map((connection) => ({
    assistantId: connection.assistantId,
    identity: connection.identity,
    addressing: checkAddressed(message, chat.type, {
      id: connection.botId,
      username: connection.identity.botUsername,
    }),
  }));

  const replyTo = message.reply_to_message;
  const replyAuthor = replyTo?.from ?? null;
  const replyAuthorAssistant = replyAuthor?.is_bot
    ? (deps.running().find((c) => c.botId === replyAuthor.id)?.assistantId ?? null)
    : null;

  const event = transportMessageEventSchema.parse({
    ...updateEnvelope(`${chatId}:${message.message_id}`),
    type: "transport.message",
    source: "tg",
    receivedBy: deps.assistantId,
    chat: {
      id: chatId,
      kind: isGroup ? "group" : "direct",
      title: chat.title ?? null,
      type: isGroup ? chat.type : null,
    },
    // Owner rights are the core's judgement (Phase 8) - this app only
    // reports who spoke.
    sender: {
      userId: senderId,
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    },
    message: {
      sourceMessageId: String(message.message_id),
      content: text,
      sentAt: new Date(message.date * 1000).toISOString(),
      threadId: message.message_thread_id != null ? String(message.message_thread_id) : null,
      replyTo: replyTo
        ? {
            sourceMessageId: String(replyTo.message_id),
            hasMedia: detectMessageMedia(replyTo as Message) !== null,
            text: replyTo.text ?? replyTo.caption ?? null,
            quote: message.quote?.text ?? null,
            author:
              replyAuthor && !replyAuthor.is_bot
                ? {
                    userId: String(replyAuthor.id),
                    username: replyAuthor.username?.toLowerCase() ?? null,
                    firstName: replyAuthor.first_name ?? null,
                    lastName: replyAuthor.last_name ?? null,
                  }
                : null,
            authorAssistantId: replyAuthorAssistant,
          }
        : null,
    },
    media,
    receivers,
    dedupeKey,
  } satisfies TransportMessageEvent);

  return { status: "forwarded", event };
}

/** The presence stamp for a suppressed duplicate group receipt. */
export function presenceEvent(input: {
  chatId: string;
  assistantId: string;
}): TransportUpdateEvent {
  return {
    ...updateEnvelope(`presence:${input.chatId}:${input.assistantId}`),
    type: "transport.presence",
    source: "tg",
    chatId: input.chatId,
    assistantId: input.assistantId,
  };
}
