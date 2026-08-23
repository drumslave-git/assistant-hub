import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  scopedRef,
  type ConnectionIdentity,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import type { Message } from "@grammyjs/types";

import type { TgDb } from "./db";
import { checkAddressed } from "./addressing";
import { buildChatInfo, buildConversationContext, buildSenderInfo } from "./context";
import { formatUserLabel } from "./format";
import { detectMessageMedia } from "./media/detect";
import { ingestMessageMedia, type FileDownloader } from "./media/ingest";
import { appendMessage, isMessageMirrored, upsertChatActivity, upsertUser } from "./store";

/**
 * Transport-agnostic inbound processing (the tg half of what v1's
 * `processUpdate` did): remember the sender, mirror the message into this
 * app's store, resolve the owner flag, compose the conversation context,
 * and hand ONE normalized inbound event to `enqueue` — the core's pipeline
 * consumes it from the queue and never reads this database.
 *
 * Deliberately does NOT decide anything about replying: addressing,
 * policy gates and the LLM turn are the core's business. Messages from
 * bots are still mirrored-not-forwarded the way v1 ignored them — the
 * assistant never answers bots, and Phase 3's bot-to-bot rules arrive with
 * assistants.
 *
 * Media (slice B): ingested here — downloaded with the connection's token,
 * normalized, stored `pending` in this app's store — and carried on the
 * event as text-or-pending references; the core describes/transcribes over
 * the internal media API and writes the text back.
 */

export interface InboundResult {
  status: "enqueued" | "mirrored_only" | "skipped";
  reason?: string;
  event?: InboundMessageEvent;
}

export interface InboundDeps {
  db: TgDb;
  /** The connection (bot) that received the update. */
  assistantId: string;
  identity: ConnectionIdentity;
  /** Numeric Telegram id of the receiving bot (self-detection in quotes). */
  botId: number;
  /** The connection's bot token — media downloads need it. */
  botToken: string;
  /** Publish the event as one queue job. Failures surface to the caller. */
  enqueue: (event: InboundMessageEvent) => Promise<void>;
  /** Test seam: fake the Telegram file download. */
  download?: FileDownloader;
  now?: () => Date;
}

/** Handle one incoming Telegram `message` update. */
export async function processIncomingMessage(
  message: Message,
  deps: InboundDeps,
): Promise<InboundResult> {
  const from = message.from;
  const chat = message.chat;
  const chatId = String(chat.id);
  const text = message.text ?? message.caption ?? "";
  const isGroup = chat.type !== "private";
  const now = deps.now?.() ?? new Date();

  // Bot-authored messages: not mirrored (the media FK convention relies on
  // it) and never answered — v1 behavior, revisited in Phase 3.
  if (!from || from.is_bot) {
    return { status: "skipped", reason: "bot_or_anonymous_sender" };
  }
  const hasMedia = detectMessageMedia(message) !== null;
  if (!text.trim() && !hasMedia) {
    return { status: "skipped", reason: "no_content" };
  }

  const senderId = String(from.id);
  // Remember every human sender + mirror every human message (addressed or
  // not) so the operator sees who talks to the bot and the window holds the
  // whole running conversation. Mirror first, in insertion order.
  await upsertUser(deps.db, {
    userId: senderId,
    username: from.username?.toLowerCase() ?? null,
    firstName: from.first_name ?? null,
    lastName: from.last_name ?? null,
  });
  if (chat.type === "group" || chat.type === "supergroup") {
    await upsertChatActivity(deps.db, {
      chatId,
      title: chat.title ?? null,
      type: chat.type,
      userId: senderId,
    });
  }
  // `processed: false` takes the live-processing hold; the lifecycle
  // consumer releases it when the core settles the turn (and the backfill's
  // expiry covers a core that never does).
  const mirrored = await appendMessage(deps.db, {
    chatId,
    telegramMessageId: message.message_id,
    role: "user",
    userId: senderId,
    content: text,
    replyToMessageId: message.reply_to_message?.message_id ?? null,
    sentAt: new Date(message.date * 1000),
    processed: false,
  });
  if (!mirrored) {
    // Idempotency: a re-delivered update was already mirrored — and already
    // enqueued. A second queue job would run the same turn twice.
    return { status: "skipped", reason: "already_mirrored" };
  }

  // Ingest media after the mirror (its FK requires the message row). A media
  // message the ingest cannot store still enqueues — the core answers from
  // the text, exactly like v1's text-only degradation.
  const storedMedia = hasMedia
    ? await ingestMessageMedia({
        db: deps.db,
        token: deps.botToken,
        chatId,
        telegramMessageId: message.message_id,
        message,
        download: deps.download,
      }).catch(() => null)
    : null;

  const [chatInfo, sender, context] = await Promise.all([
    buildChatInfo(deps.db, { chatId, isGroup, title: chat.title ?? null }),
    buildSenderInfo(deps.db, {
      userId: senderId,
      username: from.username?.toLowerCase() ?? null,
      firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
    }),
    buildConversationContext(deps.db, {
      chatId,
      isGroup,
      senderId,
      excludeTelegramMessageId: message.message_id,
      now,
    }),
  ]);

  const replyTo = message.reply_to_message;
  const event = inboundMessageEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    // The turn's correlation — same shape v1 used, so a turn's cross-app
    // flow reads as one trace.
    correlationId: `${chatId}:${message.message_id}`,
    type: "message.inbound",
    source: "tg",
    assistantId: deps.assistantId,
    connection: deps.identity,
    chat: chatInfo,
    sender,
    // The deterministic verdict travels with the event; only the ambiguous
    // case reaches the core's LLM analyzer.
    addressing: checkAddressed(message, chat.type, {
      id: deps.botId,
      username: deps.identity.botUsername,
      displayName: deps.identity.botDisplayName,
    }),
    message: {
      sourceMessageId: String(message.message_id),
      content: text,
      sentAt: new Date(message.date * 1000).toISOString(),
      threadId: message.message_thread_id != null ? String(message.message_thread_id) : null,
      replyTo: replyTo
        ? {
            sourceMessageId: String(replyTo.message_id),
            // Mirrored targets render as dereferenceable anchors in the
            // core's transcript; unmirrored ones get sender + text inlined.
            stored: await isMessageMirrored(deps.db, chatId, replyTo.message_id),
            // The core resolves replied-to media to text over the media API.
            hasMedia: detectMessageMedia(replyTo as Message) !== null,
            senderLabel: replyTo.from
              ? replyTo.from.id === deps.botId
                ? null
                : formatUserLabel({
                    userId: String(replyTo.from.id),
                    username: replyTo.from.username ?? null,
                    firstName: replyTo.from.first_name ?? null,
                    lastName: replyTo.from.last_name ?? null,
                  })
              : null,
            fromAssistant: replyTo.from?.id === deps.botId,
            text: replyTo.text ?? replyTo.caption ?? null,
            quote: message.quote?.text ?? null,
          }
        : null,
      media: storedMedia
        ? [
            {
              id: storedMedia.id,
              kind: storedMedia.kind,
              description: storedMedia.description,
              status: storedMedia.status as "pending" | "described" | "unavailable",
            },
          ]
        : [],
    },
    context,
  } satisfies InboundMessageEvent);

  await deps.enqueue(event);
  return { status: "enqueued", event };
}

/** Scoped chat ref for a raw Telegram chat id. */
export function tgChatRef(chatId: string): string {
  return scopedRef("tg", "chat", chatId);
}
