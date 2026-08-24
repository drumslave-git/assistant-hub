import { and, asc, count, eq, gte, inArray, isNull, lt, lte, max, ne, sql } from "drizzle-orm";

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

/** Whether a chat id is a DM (group ids are negative). */
export function isDirectChat(chatId: string): boolean {
  return !chatId.startsWith("-");
}

/**
 * Predicate selecting ONE conversation's rows. A group is one shared stream
 * (chat-wide); a DM's chat id is the peer's user id — shared by every bot
 * that talks to them — so the stream is per assistant there. A null
 * assistant reads a DM unscoped (the content/operator plane, which is not
 * assistant-aware yet — recorded follow-up).
 */
function conversationFilter(chatId: string, assistantId: string | null) {
  const base = eq(messages.chatId, chatId);
  if (!isDirectChat(chatId) || assistantId == null) return base;
  return and(base, eq(messages.assistantId, assistantId))!;
}

/**
 * Append a message to the mirror. Idempotent per conversation — groups on
 * `(chat_id, telegram_message_id)`, DMs with the assistant dimension (the
 * partial unique index pair) — so a re-delivered update changes nothing.
 * Returns null when the row existed.
 */
export async function appendMessage(
  db: TgDb,
  input: {
    chatId: string;
    /**
     * The assistant whose conversation this is: required for DM rows and for
     * assistant-authored rows (the author); null for group USER rows — the
     * shared stream every poller mirrors idempotently.
     */
    assistantId: string | null;
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
    // No explicit target: whichever partial unique index (group or DM shape)
    // the row falls under decides the conflict.
    .onConflictDoNothing()
    .returning();
  return rows[0] ?? null;
}

/** One mirrored message of a conversation by its Telegram id, or null. */
export async function getMessageByTelegramId(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
  assistantId: string | null,
): Promise<MessageRow | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(conversationFilter(chatId, assistantId), eq(messages.telegramMessageId, telegramMessageId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Which of the given Telegram message ids exist in this chat's mirror — the
 * whitelist behind `#<id>` citation links (v1 `getChatMessagesByTelegramIds`
 * narrowed to what link resolution needs): a model that misreads an id, or
 * invents one, gets plain text rather than a link to a message nobody can
 * open.
 */
export async function filterMirroredMessageIds(
  db: TgDb,
  chatId: string,
  telegramMessageIds: number[],
  assistantId: string | null,
): Promise<number[]> {
  if (telegramMessageIds.length === 0) return [];
  const rows = await db
    .select({ telegramMessageId: messages.telegramMessageId })
    .from(messages)
    .where(
      and(
        conversationFilter(chatId, assistantId),
        inArray(messages.telegramMessageId, telegramMessageIds),
      ),
    );
  return rows.map((row) => row.telegramMessageId);
}

/**
 * Record the bot's own reaction badge on a mirrored message (current state —
 * a new emoji replaces the old, null clears it), so the transcript renders
 * it and the next turn remembers reacting (v1 `recordBotReaction`).
 */
export async function recordBotReaction(
  db: TgDb,
  input: {
    chatId: string;
    telegramMessageId: number;
    emoji: string | null;
    assistantId: string | null;
  },
): Promise<void> {
  await db
    .update(messages)
    .set({ botReaction: input.emoji, botReactedAt: new Date() })
    .where(
      and(
        conversationFilter(input.chatId, input.assistantId),
        eq(messages.telegramMessageId, input.telegramMessageId),
      ),
    );
}

/**
 * Soft-delete a mirrored message (the bot's own deletions only — a removed
 * browsing acknowledgement, a retired feedback menu). The row stays for
 * insertion-order integrity; reads exclude it via `deleted_at`.
 */
export async function markMessageDeleted(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
  assistantId: string | null,
): Promise<void> {
  await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        conversationFilter(chatId, assistantId),
        eq(messages.telegramMessageId, telegramMessageId),
      ),
    );
}

/** Whether a message is in the conversation's mirror (reply targets render as anchors then). */
export async function isMessageMirrored(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
  assistantId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        conversationFilter(chatId, assistantId),
        eq(messages.telegramMessageId, telegramMessageId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Release a message's live-processing hold (see `messages.processed`). */
export async function markMessageProcessed(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
  assistantId: string | null,
): Promise<void> {
  await db
    .update(messages)
    .set({ processed: true })
    .where(
      and(
        conversationFilter(chatId, assistantId),
        eq(messages.telegramMessageId, telegramMessageId),
      ),
    );
}

/** Apply a Telegram `edited_message` to the mirror. No-op when never mirrored. */
export async function applyMessageEdit(
  db: TgDb,
  input: {
    chatId: string;
    telegramMessageId: number;
    content: string;
    editedAt: Date;
    assistantId: string | null;
  },
): Promise<void> {
  await db
    .update(messages)
    .set({ content: input.content, editedAt: input.editedAt })
    .where(
      and(
        conversationFilter(input.chatId, input.assistantId),
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
  options?: { excludeTelegramMessageId?: number; assistantId?: string | null },
): Promise<MessageRow[]> {
  const filters = [
    conversationFilter(chatId, options?.assistantId ?? null),
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

// ---- Operator listing/CRUD (slice D) ---------------------------------------
// The reads and writes behind the shared operator contract
// (`@assistant-hub/contracts` operator-api): what the dashboard's users /
// groups / history / bot-control views need, ported from the v1
// known-users / known-groups / history repositories.

/** Every user this source knows, oldest first (v1 listing order). */
export async function listUsers(db: TgDb): Promise<UserRow[]> {
  return db.select().from(users).orderBy(asc(users.firstSeenAt));
}

/** Replace a user's operator-curated aliases. Null when the user is unknown. */
export async function updateUserAliases(
  db: TgDb,
  userId: string,
  aliases: string[],
): Promise<UserRow | null> {
  const rows = await db
    .update(users)
    .set({ aliases, updatedAt: new Date() })
    .where(eq(users.userId, userId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a user's DM reply language. Null when the user is unknown. */
export async function updateUserLanguage(
  db: TgDb,
  userId: string,
  language: string | null,
): Promise<UserRow | null> {
  const rows = await db
    .update(users)
    .set({ language, updatedAt: new Date() })
    .where(eq(users.userId, userId))
    .returning();
  return rows[0] ?? null;
}

/** Mirror aggregates + chat metadata for the operator chat listing. */
export interface ChatListing {
  chatId: string;
  chat: ChatRow | null;
  messageCount: number;
  lastMessageAt: Date | null;
}

/**
 * Every conversation the source carries, newest activity first: mirror
 * aggregates for every chat that has messages (soft-deleted rows excluded),
 * merged with the chat rows (groups) — a group the bot joined but that has
 * no mirrored traffic yet still lists.
 */
export async function listChatListings(db: TgDb): Promise<ChatListing[]> {
  const [aggregates, chatRows] = await Promise.all([
    db
      .select({
        chatId: messages.chatId,
        messageCount: count(),
        lastMessageAt: max(messages.sentAt),
      })
      .from(messages)
      .where(isNull(messages.deletedAt))
      .groupBy(messages.chatId),
    db.select().from(chats),
  ]);
  const byId = new Map<string, ChatListing>();
  for (const row of aggregates) {
    byId.set(row.chatId, {
      chatId: row.chatId,
      chat: null,
      messageCount: Number(row.messageCount),
      lastMessageAt: row.lastMessageAt,
    });
  }
  for (const chat of chatRows) {
    const existing = byId.get(chat.chatId);
    if (existing) {
      existing.chat = chat;
    } else {
      byId.set(chat.chatId, { chatId: chat.chatId, chat, messageCount: 0, lastMessageAt: null });
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
  );
}

/** Set (or clear) a group's operator notes. Null when the chat is unknown. */
export async function updateChatNotes(
  db: TgDb,
  chatId: string,
  notes: string | null,
): Promise<ChatRow | null> {
  const rows = await db
    .update(chats)
    .set({ notes, updatedAt: new Date() })
    .where(eq(chats.chatId, chatId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a group's reply language. Null when the chat is unknown. */
export async function updateChatLanguage(
  db: TgDb,
  chatId: string,
  language: string | null,
): Promise<ChatRow | null> {
  const rows = await db
    .update(chats)
    .set({ language, updatedAt: new Date() })
    .where(eq(chats.chatId, chatId))
    .returning();
  return rows[0] ?? null;
}

/** One chat's full mirror, oldest first (the dashboard's history detail). */
export async function listChatMessages(db: TgDb, chatId: string): Promise<MessageRow[]> {
  return db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(asc(messages.id));
}

/** Specific mirror rows by their Telegram ids, insertion order, as stored. */
export async function getMessagesByTelegramIds(
  db: TgDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<MessageRow[]> {
  if (telegramMessageIds.length === 0) return [];
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), inArray(messages.telegramMessageId, telegramMessageIds)))
    .orderBy(asc(messages.id));
}

/**
 * Mirror rows sent within a window, insertion order, as stored. The end is
 * inclusive for user-facing range reads and exclusive for calendar-day
 * reads (a day ends exactly where the next begins — v1 semantics).
 */
export async function getMessagesInWindow(
  db: TgDb,
  chatId: string,
  window: { from: Date; to: Date; endExclusive: boolean },
): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        gte(messages.sentAt, window.from),
        window.endExclusive ? lt(messages.sentAt, window.to) : lte(messages.sentAt, window.to),
      ),
    )
    .orderBy(asc(messages.id));
}

/**
 * Append many mirror rows in one statement, skipping any whose
 * `(chat, telegram id)` already exists — the CSV import's write path.
 * Returns how many were actually inserted.
 */
export async function appendMessagesBulk(
  db: TgDb,
  values: readonly {
    chatId: string;
    telegramMessageId: number;
    role: "user" | "assistant";
    userId: string | null;
    content: string;
    replyToMessageId: number | null;
    sentAt: Date;
    editedAt: Date | null;
    deletedAt: Date | null;
  }[],
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await db
    .insert(messages)
    .values(values.map((v) => ({ ...v, processed: true })))
    .onConflictDoNothing({ target: [messages.chatId, messages.telegramMessageId] })
    .returning({ id: messages.id });
  return rows.length;
}

/** All connections, oldest first (the operator listing). */
export async function listConnections(db: TgDb): Promise<ConnectionRow[]> {
  return db.select().from(connections).orderBy(asc(connections.createdAt));
}

export async function getConnection(db: TgDb, id: string): Promise<ConnectionRow | null> {
  const rows = await db.select().from(connections).where(eq(connections.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Create one connection (one bot per assistant — the unique index enforces it). */
export async function insertConnection(
  db: TgDb,
  values: { id: string; assistantId: string; botToken: string; enabled: boolean },
): Promise<ConnectionRow> {
  const rows = await db.insert(connections).values(values).returning();
  return rows[0];
}

/** Update a connection's desired state. Null when the connection is unknown. */
export async function updateConnection(
  db: TgDb,
  id: string,
  values: { botToken?: string; enabled?: boolean },
): Promise<ConnectionRow | null> {
  const rows = await db
    .update(connections)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(connections.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Delete a connection. Null when it was already gone. */
export async function deleteConnection(db: TgDb, id: string): Promise<ConnectionRow | null> {
  const rows = await db.delete(connections).where(eq(connections.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Delete every connection keyed on one assistant (the `assistant.deleted`
 * reaction — PLAN "Entity lifecycle across apps"). Returns the deleted rows
 * so the caller can stop their pollers.
 */
export async function deleteConnectionsByAssistant(
  db: TgDb,
  assistantId: string,
): Promise<ConnectionRow[]> {
  return db.delete(connections).where(eq(connections.assistantId, assistantId)).returning();
}

/**
 * Set (or clear) the owner identity. A caller that already knows the
 * numeric id (the dashboard picks the owner from the user listing) passes
 * it; otherwise changing the @username resets the resolved id — the new
 * owner is re-resolved on their first message (v1 semantics, owned by this
 * app since the split).
 */
export async function setOwner(
  db: TgDb,
  input: { ownerUsername: string | null; ownerUserId?: string | null },
): Promise<void> {
  const current = await getTgSettings(db);
  const normalized = input.ownerUsername?.trim().replace(/^@/, "").toLowerCase() || null;
  const ownerUserId =
    input.ownerUserId !== undefined
      ? input.ownerUserId
      : normalized !== current.ownerUsername
        ? null
        : current.ownerUserId;
  await db
    .update(settings)
    .set({ ownerUsername: normalized, ownerUserId, updatedAt: new Date() })
    .where(eq(settings.id, "singleton"));
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
