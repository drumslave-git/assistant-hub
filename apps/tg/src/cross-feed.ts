import { randomUUID } from "node:crypto";

import {
  inboundMessageEventSchema,
  scopedRef,
  type ConnectionIdentity,
  type InboundMessageEvent,
} from "@assistant-hub/contracts";

import { checkCrossFedAddressed } from "./addressing";
import { buildChatInfo, buildConversationContext } from "./context";
import type { TgDb } from "./db";
import { formatUserLabel } from "./format";
import type { MessageRow } from "../store/schema";
import {
  appendMessage,
  getMediaForMessages,
  getMessageByTelegramId,
  getUserById,
  isDirectChat,
  listChatAssistants,
} from "./store";

/**
 * The cross-feed (redesign Phase 3, slice E). Telegram never delivers a bot's
 * messages to another bot, so two assistants sharing a group are deaf to each
 * other: each mirrors the other's replies (the mirror is chat-wide) but is
 * never handed a turn to answer one. This module closes that gap — an
 * assistant message that lands in a group becomes an inbound event for the
 * OTHER assistants present there, indistinguishable from a real update except
 * for `authoredByAssistantId`, which the core's loop guard counts.
 *
 * Everything about who may be fed is mechanical:
 *
 * - group chats only (a DM holds one bot and one person);
 * - the assistants the chat's presence rows name, minus the author — a bot
 *   that is not in the chat could not answer there anyway;
 * - the message must carry text and must not be `silent` (a silent send is a
 *   transient acknowledgement of background work, not something to answer).
 *
 * Whether a fed assistant *replies* is not decided here: the structural
 * verdict travels on the event, the core runs the name check and the
 * analyzer, and the loop guard bounds the exchange.
 */

/** One assistant the cross-feed can hand a message to. */
export interface CrossFeedTarget {
  assistantId: string;
  /** Numeric Telegram id of the bot account serving this assistant. */
  botId: number;
  identity: ConnectionIdentity;
}

/** What an assistant just said in a chat — the mirror row's content. */
export interface AssistantMessage {
  chatId: string;
  /**
   * The assistant that authored it. Null only when the caller could not say
   * (an internal send with no `assistantId` query) — such a message is
   * mirrored but never cross-fed: there is no author to attribute it to.
   */
  assistantId: string | null;
  telegramMessageId: number;
  /** The delivered text (a voice reply's spoken text, a file's caption). */
  content: string;
  replyToMessageId: number | null;
  sentAt: Date;
  /** Source-local forum topic the message went into, or null. */
  threadId?: number | null;
  /** A transient acknowledgement — mirrored, never cross-fed. */
  silent?: boolean;
}

export interface CrossFeed {
  /** Feed one assistant message to the other assistants in its chat. */
  feed: (message: AssistantMessage) => Promise<InboundMessageEvent[]>;
}

export interface CrossFeedDeps {
  db: TgDb;
  /** The connections running right now, with their bot identities. */
  targets: () => CrossFeedTarget[];
  /** Publish one event as a queue job (the same producer inbound uses). */
  enqueue: (event: InboundMessageEvent) => Promise<void>;
  onError?: (context: string, error: unknown) => void;
  now?: () => Date;
}

/**
 * The turn's correlation for a cross-fed message. One delivered message can
 * open a turn for every other assistant in the chat, so the receiver is part
 * of the id — turn-action markers and traces key on it and must not collide
 * (an ordinary turn keeps the plain `<chatId>:<messageId>` shape).
 */
export function crossFedCorrelationId(
  chatId: string,
  telegramMessageId: number,
  targetAssistantId: string,
): string {
  return `${chatId}:${telegramMessageId}:${targetAssistantId}`;
}

/** Build the inbound event one target assistant receives. */
async function buildCrossFedEvent(
  deps: CrossFeedDeps,
  message: AssistantMessage,
  author: CrossFeedTarget,
  target: CrossFeedTarget,
): Promise<InboundMessageEvent> {
  const now = deps.now?.() ?? new Date();
  const { chatId } = message;
  // The reply target as the RECEIVING assistant sees it: a group is one
  // shared stream, so an unscoped read is the whole conversation.
  const replyRow =
    message.replyToMessageId != null
      ? await getMessageByTelegramId(deps.db, chatId, message.replyToMessageId, null)
      : null;
  const repliesToOwnMessage =
    replyRow?.role === "assistant" && replyRow.assistantId === target.assistantId;

  const [chat, context, replySender, replyMedia] = await Promise.all([
    buildChatInfo(deps.db, { chatId, isGroup: true, title: null }),
    buildConversationContext(deps.db, {
      chatId,
      isGroup: true,
      senderId: null,
      // Group history is the shared stream — every assistant's lines
      // included, each attributed by the row's own assistant id.
      assistantId: null,
      excludeTelegramMessageId: message.telegramMessageId,
      now,
    }),
    replyRow?.userId ? getUserById(deps.db, replyRow.userId) : Promise.resolve(null),
    message.replyToMessageId != null
      ? getMediaForMessages(deps.db, chatId, [message.replyToMessageId])
      : Promise.resolve(new Map()),
  ]);

  return inboundMessageEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: now.toISOString(),
    correlationId: crossFedCorrelationId(chatId, message.telegramMessageId, target.assistantId),
    type: "message.inbound",
    source: "tg",
    assistantId: target.assistantId,
    connection: target.identity,
    chat,
    // The author's bot ACCOUNT, which is what this app knows; the core
    // resolves the speaking assistant's own name from
    // `authoredByAssistantId` and never treats this ref as a person.
    sender: {
      ref: scopedRef("tg", "user", String(author.botId)),
      isOwner: false,
      label: author.identity.botDisplayName,
      username: author.identity.botUsername,
      firstName: author.identity.botDisplayName,
      lastName: null,
      aliases: [],
      language: null,
    },
    authoredByAssistantId: author.assistantId,
    addressing: checkCrossFedAddressed({
      text: message.content,
      botUsername: target.identity.botUsername,
      repliesToOwnMessage,
    }),
    message: {
      sourceMessageId: String(message.telegramMessageId),
      content: message.content,
      sentAt: message.sentAt.toISOString(),
      threadId: message.threadId != null ? String(message.threadId) : null,
      replyTo:
        message.replyToMessageId != null
          ? {
              sourceMessageId: String(message.replyToMessageId),
              stored: replyRow != null,
              hasMedia: replyMedia.has(message.replyToMessageId),
              senderLabel: replySender ? formatUserLabel(replySender) : null,
              fromAssistant: repliesToOwnMessage,
              text: replyRow?.content ?? null,
              quote: null,
            }
          : null,
      // A generated image is delivered as its own captionless message, which
      // carries no text to answer and is never fed (see `feed`).
      media: [],
    },
    context,
  } satisfies InboundMessageEvent);
}

/** Wire a cross-feed over this app's store, running pollers, and queue. */
export function createCrossFeed(deps: CrossFeedDeps): CrossFeed {
  const onError =
    deps.onError ??
    ((context: string, error: unknown) => console.error(`[tg cross-feed] ${context}:`, error));

  return {
    async feed(message: AssistantMessage): Promise<InboundMessageEvent[]> {
      if (isDirectChat(message.chatId)) return [];
      if (!message.assistantId) return [];
      if (message.silent || !message.content.trim()) return [];
      const running = deps.targets();
      const author = running.find((t) => t.assistantId === message.assistantId);
      // Without the author's bot account there is no honest sender to put on
      // the event — the connection stopped between the send and this call.
      if (!author) return [];
      const present = new Set(await listChatAssistants(deps.db, message.chatId));
      const targets = running.filter(
        (t) => t.assistantId !== message.assistantId && present.has(t.assistantId),
      );
      const fed: InboundMessageEvent[] = [];
      for (const target of targets) {
        try {
          const event = await buildCrossFedEvent(deps, message, author, target);
          await deps.enqueue(event);
          fed.push(event);
        } catch (error) {
          // One deaf assistant must not cost the others their turn, and never
          // the delivery that triggered this.
          onError(
            `cross-feed of ${message.chatId}:${message.telegramMessageId} to ${target.assistantId}`,
            error,
          );
        }
      }
      return fed;
    },
  };
}

/**
 * Mirror what an assistant just delivered and cross-feed it — the one seam
 * every outbound path goes through (the reply-delivery consumer and each
 * internal send endpoint), so no delivery can grow a mirror row without the
 * other assistants in the chat hearing it.
 *
 * Returns the mirror row, or null when the row already existed (a re-delivery
 * — which is also why the feed only runs for a genuinely new row).
 */
export async function recordAssistantMessage(
  db: TgDb,
  message: AssistantMessage,
  crossFeed?: CrossFeed,
): Promise<MessageRow | null> {
  const row = await appendMessage(db, {
    chatId: message.chatId,
    assistantId: message.assistantId,
    telegramMessageId: message.telegramMessageId,
    role: "assistant",
    userId: null,
    content: message.content,
    replyToMessageId: message.replyToMessageId,
    sentAt: message.sentAt,
    processed: true,
  });
  if (row && crossFeed) {
    // Detached from the delivery: the message is already sent and mirrored,
    // and a cross-feed failure must not undo either.
    void crossFeed.feed(message).catch(() => undefined);
  }
  return row;
}
