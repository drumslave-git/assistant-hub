import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  scopedRef,
  turnCorrelationId,
  type ConnectionIdentity,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";
import type { Message } from "@grammyjs/types";

import { listeningAssistants, type AssistantConnection } from "./audience";
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
 *
 * **A group message is a turn for every assistant in the chat** (slice E).
 * Telegram delivers it to each bot, but the group mirror is ONE shared
 * stream, so exactly one poller wins the insert and the others see
 * `already_mirrored`. That winner therefore enqueues an event per listening
 * assistant rather than only its own — each with its own connection
 * identity, its own structural addressing verdict, and its own turn
 * correlation. Doing it here, once, is also what keeps a photo from being
 * downloaded and ingested once per bot in the chat.
 */

export interface InboundResult {
  status: "enqueued" | "mirrored_only" | "skipped";
  reason?: string;
  /** One per assistant handed a turn — several when a group shares bots. */
  events?: InboundMessageEvent[];
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
  /**
   * Every connection running right now. A group message is a turn for each
   * of them present in the chat (see the module note); absent → the
   * receiving connection alone, which is every direct chat and every
   * single-bot deployment.
   */
  running?: () => AssistantConnection[];
  /** Publish one event as one queue job. Failures surface to the caller. */
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
  // Anchors are chat-wide in a group and single-stream in a DM, so one read
  // answers for every receiver below.
  const replyTargetStored = replyTo
    ? await isMessageMirrored(deps.db, chatId, replyTo.message_id, deps.assistantId)
    : false;
  const media = storedMedia
    ? [
        {
          id: storedMedia.id,
          kind: storedMedia.kind,
          description: storedMedia.description,
          status: storedMedia.status as "pending" | "described" | "unavailable",
        },
      ]
    : [];

  /** The event ONE assistant receives for this message. */
  const eventFor = (receiver: AssistantConnection): InboundMessageEvent =>
    inboundMessageEventSchema.parse({
      v: 1,
      eventId: randomUUID(),
      occurredAt: now.toISOString(),
      // One turn = one assistant acting on one message (see
      // `turnCorrelationId`): several assistants can be handed the same
      // message, and their markers and traces must not collide.
      correlationId: turnCorrelationId(
        chatId,
        String(message.message_id),
        receiver.assistantId,
      ),
      type: "message.inbound",
      source: "tg",
      assistantId: receiver.assistantId,
      connection: receiver.identity,
      chat: chatInfo,
      sender,
      // The STRUCTURAL verdict travels with the event (reply/@mention/command/
      // DM), judged against THIS receiver's bot account; the name half runs
      // core-side against its assistant's name.
      addressing: checkAddressed(message, chat.type, {
        id: receiver.botId,
        username: receiver.identity.botUsername,
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
              stored: replyTargetStored,
              // The core resolves replied-to media to text over the media API.
              hasMedia: detectMessageMedia(replyTo as Message) !== null,
              senderLabel: replyTo.from
                ? replyTo.from.id === receiver.botId
                  ? null
                  : formatUserLabel({
                      userId: String(replyTo.from.id),
                      username: replyTo.from.username ?? null,
                      firstName: replyTo.from.first_name ?? null,
                      lastName: replyTo.from.last_name ?? null,
                    })
                : null,
              fromAssistant: replyTo.from?.id === receiver.botId,
              text: replyTo.text ?? replyTo.caption ?? null,
              quote: message.quote?.text ?? null,
            }
          : null,
        media,
      },
      context,
    } satisfies InboundMessageEvent);

  const events = (await resolveReceivers(deps, { chatId, isGroup })).map(eventFor);
  for (const event of events) await deps.enqueue(event);
  return { status: "enqueued", events };
}

/**
 * Who gets a turn for this message. A direct chat is between one person and
 * one bot, so it is the receiving connection alone. A group is every
 * assistant listening there — the receiving connection included, since its
 * own presence was stamped above, and it is re-added defensively so a
 * presence read that comes back empty can never cost the bot that actually
 * got the update its turn.
 */
async function resolveReceivers(
  deps: InboundDeps,
  input: { chatId: string; isGroup: boolean },
): Promise<AssistantConnection[]> {
  const self: AssistantConnection = {
    assistantId: deps.assistantId,
    botId: deps.botId,
    identity: deps.identity,
  };
  if (!input.isGroup || !deps.running) return [self];
  const listening = await listeningAssistants(deps.db, input.chatId, deps.running()).catch(
    () => [],
  );
  if (!listening.some((connection) => connection.assistantId === self.assistantId)) {
    return [self, ...listening];
  }
  return listening;
}

/** Scoped chat ref for a raw Telegram chat id. */
export function tgChatRef(chatId: string): string {
  return scopedRef("tg", "chat", chatId);
}
