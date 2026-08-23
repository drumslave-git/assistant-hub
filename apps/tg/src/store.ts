import { and, asc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";

import {
  chatMembers,
  chats,
  connections,
  media,
  messages,
  settings,
  users,
  type ChatRow,
  type ConnectionRow,
  type MessageRow,
  type UserRow,
} from "../store/schema";
import type { TgDb } from "./db";

/**
 * Store operations the tg runtime needs (Slice A of the source split:
 * mirror, membership, context reads, connections, owner settings). Ports of
 * the v1 repositories, operating on this app's own database. Best-effort
 * semantics (what may fail without dropping a turn) live in the callers.
 */

/** Upsert a user's Telegram profile; operator-curated fields are never touched. */
export async function upsertUser(
  db: TgDb,
  input: {
    userId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  },
): Promise<void> {
  await db
    .insert(users)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: users.userId,
      set: {
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upsert a group chat (title/type refreshed; notes/language never touched)
 * and record the sender as a member. Call after {@link upsertUser} — the
 * membership FK needs the user row.
 */
export async function upsertChatActivity(
  db: TgDb,
  input: { chatId: string; title: string | null; type: string; userId: string },
): Promise<void> {
  await db
    .insert(chats)
    .values({
      chatId: input.chatId,
      title: input.title,
      type: input.type,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: chats.chatId,
      set: { title: input.title, type: input.type, updatedAt: new Date() },
    });
  await db
    .insert(chatMembers)
    .values({ chatId: input.chatId, userId: input.userId })
    .onConflictDoUpdate({
      target: [chatMembers.chatId, chatMembers.userId],
      set: { lastSeenAt: new Date() },
    });
}

/**
 * Append a message to the mirror. Idempotent on `(chat_id, telegram_message_id)`
 * — a re-delivered update changes nothing. Returns null when the row existed.
 */
export async function appendMessage(
  db: TgDb,
  input: {
    chatId: string;
    telegramMessageId: number;
    role: "user" | "assistant";
    userId: string | null;
    content: string;
    replyToMessageId: number | null;
    sentAt: Date;
    /** False takes the live-processing hold (released when the turn settles). */
    processed: boolean;
  },
): Promise<MessageRow | null> {
  const rows = await db
    .insert(messages)
    .values(input)
    .onConflictDoNothing({ target: [messages.chatId, messages.telegramMessageId] })
    .returning();
  return rows[0] ?? null;
}

/** Release a message's live-processing hold (see `messages.processed`). */
export async function markMessageProcessed(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
): Promise<void> {
  await db
    .update(messages)
    .set({ processed: true })
    .where(and(eq(messages.chatId, chatId), eq(messages.telegramMessageId, telegramMessageId)));
}

/** Apply a Telegram `edited_message` to the mirror. No-op when never mirrored. */
export async function applyMessageEdit(
  db: TgDb,
  input: { chatId: string; telegramMessageId: number; content: string; editedAt: Date },
): Promise<void> {
  await db
    .update(messages)
    .set({ content: input.content, editedAt: input.editedAt })
    .where(
      and(
        eq(messages.chatId, input.chatId),
        eq(messages.telegramMessageId, input.telegramMessageId),
      ),
    );
}

/**
 * The chat's live messages since `since` (24h window source), insertion
 * order, excluding the current turn and soft-deleted rows — the v1
 * `getChatMessagesSince` semantics.
 */
export async function getMessagesSince(
  db: TgDb,
  chatId: string,
  since: Date,
  options?: { excludeTelegramMessageId?: number },
): Promise<MessageRow[]> {
  const filters = [
    eq(messages.chatId, chatId),
    gte(messages.sentAt, since),
    isNull(messages.deletedAt),
  ];
  if (options?.excludeTelegramMessageId != null) {
    filters.push(ne(messages.telegramMessageId, options.excludeTelegramMessageId));
  }
  return db
    .select()
    .from(messages)
    .where(and(...filters))
    .orderBy(asc(messages.id));
}

/** Users by id, for label resolution. */
export async function getUsersByIds(db: TgDb, userIds: string[]): Promise<UserRow[]> {
  if (userIds.length === 0) return [];
  return db.select().from(users).where(inArray(users.userId, userIds));
}

export async function getUserById(db: TgDb, userId: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export async function getChatById(db: TgDb, chatId: string): Promise<ChatRow | null> {
  const rows = await db.select().from(chats).where(eq(chats.chatId, chatId)).limit(1);
  return rows[0] ?? null;
}

/** A group's known members (joined to their user rows), for the roster. */
export async function listChatMemberUsers(db: TgDb, chatId: string): Promise<UserRow[]> {
  const rows = await db
    .select({ user: users })
    .from(chatMembers)
    .innerJoin(users, eq(chatMembers.userId, users.userId))
    .where(eq(chatMembers.chatId, chatId))
    .orderBy(asc(chatMembers.firstSeenAt));
  return rows.map((row) => row.user);
}

/** Media rows for a set of the chat's messages (history annotations). */
export async function getMediaForMessages(
  db: TgDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<Map<number, { id: string; kind: string; description: string | null; status: string }>> {
  if (telegramMessageIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(media)
    .where(and(eq(media.chatId, chatId), inArray(media.telegramMessageId, telegramMessageIds)));
  return new Map(
    rows.map((row) => [
      row.telegramMessageId,
      { id: row.id, kind: row.kind, description: row.description, status: row.status },
    ]),
  );
}

/** Enabled telegram connections — what the reconciler runs pollers for. */
export async function listEnabledConnections(db: TgDb): Promise<ConnectionRow[]> {
  return db.select().from(connections).where(eq(connections.enabled, true));
}

/** This app's settings singleton, created empty on first read. */
export async function getTgSettings(
  db: TgDb,
): Promise<{ ownerUsername: string | null; ownerUserId: string | null }> {
  const rows = await db.select().from(settings).where(eq(settings.id, "singleton")).limit(1);
  if (rows[0]) return rows[0];
  await db.insert(settings).values({ id: "singleton" }).onConflictDoNothing();
  return { ownerUsername: null, ownerUserId: null };
}

/**
 * Persist the owner's resolved numeric id, the first time the configured
 * @username messages a bot (Telegram has no lookup by username) — v1
 * semantics, now owned by this app (user decision, 2026-08-22).
 */
export async function setResolvedOwnerUserId(db: TgDb, ownerUserId: string): Promise<void> {
  await db
    .update(settings)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(and(eq(settings.id, "singleton"), sql`${settings.ownerUserId} IS NULL`));
}
