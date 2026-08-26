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
import {
  appendMessage,
  isMessageMirrored,
  markMessageProcessed,
  upsertChatActivity,
  upsertUser,
} from "./store";

/**
 * Transport-agnostic inbound processing (the tg half of what v1's
 * `processUpdate` did): remember the sender, mirror the message into this
 * app's store, resolve the owner flag, compose the conversation context,
 * and hand ONE normalized inbound event to `enqueue` — the core's pipeline
 * consumes it from the queue and never reads this database.
 *
 * Deliberately does NOT decide anything about replying: addressing,
 * policy gates and the LLM turn are the core's business. Messages that
 * arrive from bot accounts are dropped here as v1 dropped them; another
 * ASSISTANT's message reaches this app's other connections through the
 * cross-feed instead (`cross-feed.ts`), which Telegram cannot do.
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
  /**
   * Feedback capture (slice D): claim a reply to an `awaiting_text`
   * feedback menu as that menu's free-text answer. True stops the turn —
   * the message is an answer to the 👍/👎 menu, not something for the bot
   * to respond to (it stays mirrored above; v1 behavior).
   */
  captureFeedback?: (input: {
    chatId: string;
    menuMessageId: number;
    userId: string;
    text: string;
  }) => Promise<boolean>;
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
  // it) and never answered. An assistant's own reply is already mirrored by
  // the send that made it, and reaches the chat's other assistants through
  // the cross-feed — not through an update Telegram never sends anyway.
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
      // Telegram delivered this group's traffic to THIS bot — the evidence
      // the cross-feed reads to know which assistants listen here.
      assistantId: deps.assistantId,
    });
  }
  // `processed: false` takes the live-processing hold; the lifecycle
  // consumer releases it when the core settles the turn (and the backfill's
  // expiry covers a core that never does).
  const mirrored = await appendMessage(deps.db, {
    chatId,
    // A DM row belongs to THIS bot's conversation with the peer; a group row
    // is the shared stream (null keeps the cross-poller idempotence).
    assistantId: isGroup ? null : deps.assistantId,
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

  // Feedback capture: a reply to an `awaiting_text` feedback menu from the
  // reactor is the free-text answer to the 👍/👎 menu — record it and stop,
  // the message is not a turn for the core to answer (it stays mirrored
  // above). The hold is released here since no turn will ever settle it.
  if (deps.captureFeedback && message.reply_to_message && text.trim()) {
    const captured = await deps
      .captureFeedback({
        chatId,
        menuMessageId: message.reply_to_message.message_id,
        userId: senderId,
        text,
      })
      .catch(() => false);
    if (captured) {
      await markMessageProcessed(deps.db, chatId, message.message_id, deps.assistantId).catch(
        () => undefined,
      );
      return { status: "mirrored_only", reason: "feedback_captured" };
    }
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
      assistantId: deps.assistantId,
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
    // The STRUCTURAL verdict travels with the event (reply/@mention/command/
    // DM); the name half runs core-side against the assistant's name.
    addressing: checkAddressed(message, chat.type, {
      id: deps.botId,
      username: deps.identity.botUsername,
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
            stored: await isMessageMirrored(deps.db, chatId, replyTo.message_id, deps.assistantId),
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
