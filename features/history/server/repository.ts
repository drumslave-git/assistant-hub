import "server-only";

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatMessages, type ChatMessageRow } from "@/db/schema";

/**
 * Typed persistence for the chat-history mirror (`chat_messages`). Pure data
 * access: no policy, no validation, no trace recording (the service owns those).
 * Every function takes a {@link DrizzleDb} so it runs against the pool or a test
 * instance.
 */

/** A stored chat message. */
export interface ChatMessageRecord {
  id: number;
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId: string | null;
  content: string;
  replyToMessageId: number | null;
  sentAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

/** Fields for appending a message to the mirror. */
export interface AppendChatMessage {
  chatId: string;
  telegramMessageId: number;
  role: "user" | "assistant";
  userId?: string | null;
  content: string;
  replyToMessageId?: number | null;
  sentAt: Date;
  /**
   * Live-processing semaphore (see `chat_messages.processed`). The live reply
   * pipeline appends with `false` and releases via {@link markMessageProcessed}
   * in a `finally`; every other writer omits it (defaults to `true`).
   */
  processed?: boolean;
}

/** A per-chat rollup for the History dashboard. */
export interface ChatSummary {
  chatId: string;
  messageCount: number;
  lastSentAt: string;
}

function mapRow(row: ChatMessageRow): ChatMessageRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    role: row.role === "assistant" ? "assistant" : "user",
    userId: row.userId,
    content: row.content,
    replyToMessageId: row.replyToMessageId,
    sentAt: row.sentAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Append a message to the mirror. Idempotent on `(chat_id, telegram_message_id)`
 * so a re-delivered Telegram update does not duplicate a row. Returns the stored
 * record, or null when the row already existed (conflict).
 */
export async function appendChatMessage(
  db: DrizzleDb,
  values: AppendChatMessage,
): Promise<ChatMessageRecord | null> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      role: values.role,
      userId: values.userId ?? null,
      content: values.content,
      replyToMessageId: values.replyToMessageId ?? null,
      sentAt: values.sentAt,
      ...(values.processed != null ? { processed: values.processed } : {}),
    })
    .onConflictDoNothing({
      target: [chatMessages.chatId, chatMessages.telegramMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Release a message's live-processing hold (`processed` → true). Idempotent and
 * safe for messages that never took a hold; a missing row is a no-op.
 */
export async function markMessageProcessed(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ processed: true })
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        eq(chatMessages.telegramMessageId, telegramMessageId),
        eq(chatMessages.processed, false),
      ),
    );
}

/** Fields for restoring a message from an export (carries the mirror's flags). */
export interface RestoreChatMessage extends AppendChatMessage {
  editedAt?: Date | null;
  deletedAt?: Date | null;
}

/**
 * Append many messages in one statement, skipping any row whose
 * `(chat_id, telegram_message_id)` already exists — the CSV import's write path.
 * Returns only the rows actually inserted, so the caller can report how many
 * were duplicates without a second query.
 */
export async function appendChatMessages(
  db: DrizzleDb,
  values: readonly RestoreChatMessage[],
): Promise<ChatMessageRecord[]> {
  if (values.length === 0) return [];
  const rows = await db
    .insert(chatMessages)
    .values(
      values.map((v) => ({
        chatId: v.chatId,
        telegramMessageId: v.telegramMessageId,
        role: v.role,
        userId: v.userId ?? null,
        content: v.content,
        replyToMessageId: v.replyToMessageId ?? null,
        sentAt: v.sentAt,
        editedAt: v.editedAt ?? null,
        deletedAt: v.deletedAt ?? null,
      })),
    )
    .onConflictDoNothing({
      target: [chatMessages.chatId, chatMessages.telegramMessageId],
    })
    .returning();
  return rows.map(mapRow);
}

/**
 * Every stored message, oldest first — optionally scoped to one chat. Backs the
 * CSV export, so deleted rows are included (flagged): the export is the mirror,
 * not a filtered view of it.
 */
export async function listChatMessagesForExport(
  db: DrizzleDb,
  chatId?: string,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(chatId ? eq(chatMessages.chatId, chatId) : undefined)
    .orderBy(asc(chatMessages.chatId), asc(chatMessages.id));
  return rows.map(mapRow);
}

/** One message by its Telegram id within a chat, or null. */
export async function getChatMessageByTelegramId(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<ChatMessageRecord | null> {
  const row = await db.query.chatMessages.findFirst({
    where: and(
      eq(chatMessages.chatId, chatId),
      eq(chatMessages.telegramMessageId, telegramMessageId),
    ),
  });
  return row ? mapRow(row) : null;
}

/**
 * Rewrite a message's content in place (an `edited_message` mirror). Returns the
 * updated record, or null when no matching row exists.
 */
export async function updateChatMessageContent(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
  content: string,
  editedAt: Date,
): Promise<ChatMessageRecord | null> {
  const [row] = await db
    .update(chatMessages)
    .set({ content, editedAt })
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        eq(chatMessages.telegramMessageId, telegramMessageId),
      ),
    )
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Soft-delete a mirrored message (a message the bot removed from the live chat,
 * e.g. a browsing-run acknowledgement). Returns the updated record, or null when
 * no matching row exists. The row survives for the CSV export, flagged.
 */
export async function markChatMessageDeleted(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<ChatMessageRecord | null> {
  const [row] = await db
    .update(chatMessages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        eq(chatMessages.telegramMessageId, telegramMessageId),
      ),
    )
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Non-deleted messages in a chat sent on/after `since`, oldest first (insertion
 * order). Optionally excludes one Telegram message id — used to drop the current
 * turn from its own recent-history window.
 */
export async function getChatMessagesSince(
  db: DrizzleDb,
  chatId: string,
  since: Date,
  options?: { excludeTelegramMessageId?: number },
): Promise<ChatMessageRecord[]> {
  const filters = [
    eq(chatMessages.chatId, chatId),
    gte(chatMessages.sentAt, since),
    isNull(chatMessages.deletedAt),
  ];
  if (options?.excludeTelegramMessageId != null) {
    filters.push(ne(chatMessages.telegramMessageId, options.excludeTelegramMessageId));
  }
  const rows = await db
    .select()
    .from(chatMessages)
    .where(and(...filters))
    .orderBy(asc(chatMessages.id));
  return rows.map(mapRow);
}

/**
 * Non-deleted messages in a chat matching the given Telegram message ids, oldest
 * first. Backs the `history_get_by_message_ids` MCP tool — dereferencing `#<id>`
 * transcript anchors (e.g. a reply target outside the injected window).
 */
export async function getChatMessagesByTelegramIds(
  db: DrizzleDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<ChatMessageRecord[]> {
  if (telegramMessageIds.length === 0) return [];
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        inArray(chatMessages.telegramMessageId, telegramMessageIds),
        isNull(chatMessages.deletedAt),
      ),
    )
    .orderBy(asc(chatMessages.id));
  return rows.map(mapRow);
}

/**
 * Non-deleted messages in a chat sent within `[from, to]` (inclusive), oldest
 * first. Backs the `history_get_in_range` MCP tool.
 */
export async function getChatMessagesInRange(
  db: DrizzleDb,
  chatId: string,
  from: Date,
  to: Date,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        isNull(chatMessages.deletedAt),
        gte(chatMessages.sentAt, from),
        lte(chatMessages.sentAt, to),
      ),
    )
    .orderBy(asc(chatMessages.id));
  return rows.map(mapRow);
}

/**
 * Non-deleted messages sent in `[from, to)`, oldest first — the summarizer's read.
 * Half-open (unlike {@link getChatMessagesInRange}, which serves a user-facing
 * "from this day to that day" tool and is inclusive): a calendar day ends exactly
 * where the next begins, so an inclusive bound would file midnight's message under
 * both days.
 */
export async function getChatMessagesForDay(
  db: DrizzleDb,
  chatId: string,
  from: Date,
  to: Date,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        isNull(chatMessages.deletedAt),
        gte(chatMessages.sentAt, from),
        lt(chatMessages.sentAt, to),
      ),
    )
    .orderBy(asc(chatMessages.id));
  return rows.map(mapRow);
}

/**
 * Distinct sender user ids that have posted in a chat (non-deleted `user` rows).
 * Backs chat-scoped tools that resolve a name reference to a participant, so a
 * tool can only ever touch someone who has actually spoken in the current chat.
 */
export async function getChatParticipantIds(db: DrizzleDb, chatId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: chatMessages.userId })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatId, chatId),
        isNotNull(chatMessages.userId),
        isNull(chatMessages.deletedAt),
      ),
    );
  return rows.map((r) => r.userId).filter((id): id is string => id != null);
}

/** Per-chat rollups (message count + last activity), most-recently-active first. */
export async function listChatSummaries(db: DrizzleDb): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      chatId: chatMessages.chatId,
      messageCount: sql<number>`count(*)::int`,
      lastSentAt: sql<Date>`max(${chatMessages.sentAt})`,
    })
    .from(chatMessages)
    .groupBy(chatMessages.chatId)
    .orderBy(desc(sql`max(${chatMessages.sentAt})`));
  return rows.map((row) => ({
    chatId: row.chatId,
    messageCount: row.messageCount,
    lastSentAt: new Date(row.lastSentAt).toISOString(),
  }));
}

/**
 * Stored messages for one chat, newest first — the full mirror for the dashboard
 * detail view (most recent at the top). Deleted rows are included (flagged) so
 * the mirror is complete; the caller decides how to render them.
 */
export async function getChatMessages(
  db: DrizzleDb,
  chatId: string,
  limit = 500,
): Promise<ChatMessageRecord[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.chatId, chatId))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows.map(mapRow);
}
