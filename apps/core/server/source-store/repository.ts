import "server-only";

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, max, ne } from "drizzle-orm";
import type { SourceId } from "@assistant-hub-swarm/contracts";
import { messageDedupeKey } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import {
  sourceChatAssistants,
  sourceChatMembers,
  sourceChats,
  sourceMedia,
  sourceMessages,
  sourceUsers,
  type SourceChatRow,
  type SourceMessageRow,
  type SourceUserRow,
} from "../../store/schema";

export type { SourceChatRow, SourceMessageRow, SourceUserRow };

/**
 * The generalized conversation store's repositories (redesign Phase 7) —
 * the former tg-app store layer, source-parameterized and living beside the
 * data's new home in the core store. Every function scopes by `source`;
 * nothing in this module knows what Telegram is.
 *
 * Best-effort semantics (what may fail without dropping a turn) live in the
 * callers, as before.
 */

/**
 * Which rows one CONVERSATION owns. A shared-stream chat (a group) is
 * chat-wide; a direct chat's streams are per assistant — a DM's chat id can
 * be the peer's user id, shared by every bot that talks to them. The caller
 * says which shape it is reading (`direct`, from the chat's kind on the
 * event); a null assistant reads unscoped either way (the operator/content
 * plane, which is not assistant-aware — recorded follow-up).
 */
export interface ConversationScope {
  source: SourceId;
  chatId: string;
  assistantId: string | null;
  /** Whether the chat is a direct (per-assistant-stream) conversation. */
  direct: boolean;
}

function conversationFilter(scope: ConversationScope) {
  const base = and(
    eq(sourceMessages.source, scope.source),
    eq(sourceMessages.chatId, scope.chatId),
  )!;
  if (!scope.direct || scope.assistantId == null) return base;
  return and(base, eq(sourceMessages.assistantId, scope.assistantId))!;
}

/** Upsert a user's platform profile; operator-curated fields are never touched. */
export async function upsertSourceUser(
  input: {
    source: SourceId;
    userId: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
  },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .insert(sourceUsers)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [sourceUsers.source, sourceUsers.userId],
      set: {
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upsert a group chat (title/type refreshed; notes/language never touched),
 * record the sender as a member, and stamp the receiving assistant's
 * presence. Call after {@link upsertSourceUser}.
 *
 * Presence is stamped from what the platform delivered to THAT connection —
 * the only honest evidence the bot is in the chat; the cross-feed and the
 * group fan-out read it.
 */
export async function upsertSourceChatActivity(
  input: {
    source: SourceId;
    chatId: string;
    title: string | null;
    type: string;
    userId: string;
    /** The connection that received the update; null skips the presence stamp. */
    assistantId: string | null;
  },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .insert(sourceChats)
    .values({
      source: input.source,
      chatId: input.chatId,
      title: input.title,
      type: input.type,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [sourceChats.source, sourceChats.chatId],
      set: { title: input.title, type: input.type, updatedAt: new Date() },
    });
  await db
    .insert(sourceChatMembers)
    .values({ source: input.source, chatId: input.chatId, userId: input.userId })
    .onConflictDoUpdate({
      target: [sourceChatMembers.source, sourceChatMembers.chatId, sourceChatMembers.userId],
      set: { lastSeenAt: new Date() },
    });
  if (input.assistantId) {
    await stampAssistantPresence(
      { source: input.source, chatId: input.chatId, assistantId: input.assistantId },
      db,
    );
  }
}

/** Stamp one assistant's presence in a chat (platform delivered it traffic). */
export async function stampAssistantPresence(
  input: { source: SourceId; chatId: string; assistantId: string },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .insert(sourceChatAssistants)
    .values(input)
    .onConflictDoUpdate({
      target: [
        sourceChatAssistants.source,
        sourceChatAssistants.chatId,
        sourceChatAssistants.assistantId,
      ],
      set: { lastSeenAt: new Date() },
    });
}

/** The assistants known to be present in one chat. */
export async function listChatAssistants(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<string[]> {
  const rows = await db
    .select({ assistantId: sourceChatAssistants.assistantId })
    .from(sourceChatAssistants)
    .where(and(eq(sourceChatAssistants.source, source), eq(sourceChatAssistants.chatId, chatId)));
  return rows.map((row) => row.assistantId);
}

/**
 * Append a message to the mirror. Idempotent on the transport-computed
 * dedupe key, so a re-delivered update changes nothing. Returns null when
 * the row existed.
 */
export async function appendSourceMessage(
  input: {
    source: SourceId;
    chatId: string;
    /**
     * The assistant whose conversation this is: required for direct-chat
     * rows and for assistant-authored rows (the author); null for
     * shared-stream user rows.
     */
    assistantId: string | null;
    sourceMessageId: string;
    /** The stream identity the owning transport computed. */
    dedupeKey: string;
    role: "user" | "assistant";
    userId: string | null;
    content: string;
    replyToSourceMessageId: string | null;
    sentAt: Date;
    /** False takes the live-processing hold (released when the turn settles). */
    processed: boolean;
  },
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow | null> {
  const rows = await db
    .insert(sourceMessages)
    .values(input)
    .onConflictDoNothing({ target: [sourceMessages.source, sourceMessages.dedupeKey] })
    .returning();
  return rows[0] ?? null;
}

/** One mirrored message of a conversation by its source-local id, or null. */
export async function getSourceMessage(
  scope: ConversationScope,
  sourceMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow | null> {
  const rows = await db
    .select()
    .from(sourceMessages)
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, sourceMessageId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Which of the given source-local ids exist in this conversation's mirror —
 * the whitelist behind `#<id>` citation links: a model that misreads an id,
 * or invents one, gets plain text rather than a link nobody can open.
 */
export async function filterMirroredMessageIds(
  scope: ConversationScope,
  sourceMessageIds: string[],
  db: StoreDb = getStoreDb(),
): Promise<string[]> {
  if (sourceMessageIds.length === 0) return [];
  const rows = await db
    .select({ sourceMessageId: sourceMessages.sourceMessageId })
    .from(sourceMessages)
    .where(
      and(conversationFilter(scope), inArray(sourceMessages.sourceMessageId, sourceMessageIds)),
    );
  return rows.map((row) => row.sourceMessageId);
}

/**
 * Record the bot's own reaction badge on a mirrored message (current state —
 * a new emoji replaces the old, null clears it).
 */
export async function recordBotReaction(
  scope: ConversationScope,
  input: { sourceMessageId: string; emoji: string | null },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceMessages)
    .set({ botReaction: input.emoji, botReactedAt: new Date() })
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, input.sourceMessageId)));
}

/**
 * Soft-delete a mirrored message (the bot's own deletions only). The row
 * stays for insertion-order integrity; reads exclude it via `deleted_at`.
 */
export async function markSourceMessageDeleted(
  scope: ConversationScope,
  sourceMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceMessages)
    .set({ deletedAt: new Date() })
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, sourceMessageId)));
}

/** Whether a message is in the conversation's mirror. */
export async function isMessageMirrored(
  scope: ConversationScope,
  sourceMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: sourceMessages.id })
    .from(sourceMessages)
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, sourceMessageId)))
    .limit(1);
  return rows.length > 0;
}

/** Release a message's live-processing hold (see `source_messages.processed`). */
export async function markSourceMessageProcessed(
  scope: ConversationScope,
  sourceMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceMessages)
    .set({ processed: true })
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, sourceMessageId)));
}

/** Apply a platform edit to the mirror. No-op when never mirrored. */
export async function applySourceMessageEdit(
  scope: ConversationScope,
  input: { sourceMessageId: string; content: string; editedAt: Date },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .update(sourceMessages)
    .set({ content: input.content, editedAt: input.editedAt })
    .where(and(conversationFilter(scope), eq(sourceMessages.sourceMessageId, input.sourceMessageId)));
}

/**
 * The conversation's live messages since `since` (24h window source),
 * insertion order, excluding the current turn and soft-deleted rows.
 */
export async function getSourceMessagesSince(
  scope: ConversationScope,
  since: Date,
  options?: { excludeSourceMessageId?: string },
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow[]> {
  const filters = [
    conversationFilter(scope),
    gte(sourceMessages.sentAt, since),
    isNull(sourceMessages.deletedAt),
  ];
  if (options?.excludeSourceMessageId != null) {
    filters.push(ne(sourceMessages.sourceMessageId, options.excludeSourceMessageId));
  }
  return db
    .select()
    .from(sourceMessages)
    .where(and(...filters))
    .orderBy(asc(sourceMessages.id));
}

/** Users by id, for label resolution. */
export async function getSourceUsersByIds(
  source: SourceId,
  userIds: string[],
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow[]> {
  if (userIds.length === 0) return [];
  return db
    .select()
    .from(sourceUsers)
    .where(and(eq(sourceUsers.source, source), inArray(sourceUsers.userId, userIds)));
}

export async function getSourceUserById(
  source: SourceId,
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow | null> {
  const rows = await db
    .select()
    .from(sourceUsers)
    .where(and(eq(sourceUsers.source, source), eq(sourceUsers.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSourceChatById(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceChatRow | null> {
  const rows = await db
    .select()
    .from(sourceChats)
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
    .limit(1);
  return rows[0] ?? null;
}

/** A chat's known members (joined to their user rows), for the roster. */
export async function listSourceChatMemberUsers(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow[]> {
  const rows = await db
    .select({ user: sourceUsers })
    .from(sourceChatMembers)
    .innerJoin(
      sourceUsers,
      and(
        eq(sourceChatMembers.source, sourceUsers.source),
        eq(sourceChatMembers.userId, sourceUsers.userId),
      ),
    )
    .where(and(eq(sourceChatMembers.source, source), eq(sourceChatMembers.chatId, chatId)))
    .orderBy(asc(sourceChatMembers.firstSeenAt));
  return rows.map((row) => row.user);
}

/**
 * Distinct people who have sent a message in a chat, most recent first —
 * the participants of a direct chat, which keeps no roster row.
 */
export async function listSourceChatSenderIds(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<string[]> {
  const rows = await db
    .select({ userId: sourceMessages.userId })
    .from(sourceMessages)
    .where(
      and(
        eq(sourceMessages.source, source),
        eq(sourceMessages.chatId, chatId),
        eq(sourceMessages.role, "user"),
        isNotNull(sourceMessages.userId),
      ),
    )
    .groupBy(sourceMessages.userId)
    .orderBy(desc(max(sourceMessages.sentAt)));
  return rows.map((row) => row.userId).filter((id): id is string => id != null);
}

/** Media annotations for a set of the chat's messages (history rendering). */
export async function getSourceMediaForMessages(
  source: SourceId,
  chatId: string,
  sourceMessageIds: string[],
  db: StoreDb = getStoreDb(),
): Promise<Map<string, { id: string; kind: string; description: string | null; status: string }>> {
  if (sourceMessageIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(sourceMedia)
    .where(
      and(
        eq(sourceMedia.source, source),
        eq(sourceMedia.chatId, chatId),
        inArray(sourceMedia.sourceMessageId, sourceMessageIds),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.sourceMessageId,
      { id: row.id, kind: row.kind, description: row.description, status: row.status },
    ]),
  );
}

// ---- Operator listing/CRUD -------------------------------------------------
// The reads and writes behind the shared operator contract: what the
// dashboard's users / groups / history views aggregate.

/** Every user a source knows, oldest first (v1 listing order). */
export async function listSourceUsers(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow[]> {
  return db
    .select()
    .from(sourceUsers)
    .where(eq(sourceUsers.source, source))
    .orderBy(asc(sourceUsers.firstSeenAt));
}

/** Replace a user's operator-curated aliases. Null when the user is unknown. */
export async function updateSourceUserAliases(
  source: SourceId,
  userId: string,
  aliases: string[],
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow | null> {
  const rows = await db
    .update(sourceUsers)
    .set({ aliases, updatedAt: new Date() })
    .where(and(eq(sourceUsers.source, source), eq(sourceUsers.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a user's direct-chat reply language. */
export async function updateSourceUserLanguage(
  source: SourceId,
  userId: string,
  language: string | null,
  db: StoreDb = getStoreDb(),
): Promise<SourceUserRow | null> {
  const rows = await db
    .update(sourceUsers)
    .set({ language, updatedAt: new Date() })
    .where(and(eq(sourceUsers.source, source), eq(sourceUsers.userId, userId)))
    .returning();
  return rows[0] ?? null;
}

/** Mirror aggregates + chat metadata for the operator chat listing. */
export interface SourceChatListing {
  chatId: string;
  chat: SourceChatRow | null;
  messageCount: number;
  memberCount: number;
  lastMessageAt: Date | null;
}

/**
 * Every conversation a source carries, newest activity first: mirror
 * aggregates for every chat that has messages (soft-deleted rows excluded),
 * merged with the chat rows — a group the bot joined but that has no
 * mirrored traffic yet still lists.
 */
export async function listSourceChatListings(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<SourceChatListing[]> {
  const [aggregates, chatRows, memberCounts] = await Promise.all([
    db
      .select({
        chatId: sourceMessages.chatId,
        messageCount: count(),
        lastMessageAt: max(sourceMessages.sentAt),
      })
      .from(sourceMessages)
      .where(and(eq(sourceMessages.source, source), isNull(sourceMessages.deletedAt)))
      .groupBy(sourceMessages.chatId),
    db.select().from(sourceChats).where(eq(sourceChats.source, source)),
    db
      .select({ chatId: sourceChatMembers.chatId, memberCount: count() })
      .from(sourceChatMembers)
      .where(eq(sourceChatMembers.source, source))
      .groupBy(sourceChatMembers.chatId),
  ]);
  const members = new Map(memberCounts.map((row) => [row.chatId, Number(row.memberCount)]));
  const blank = (chatId: string, chat: SourceChatRow | null): SourceChatListing => ({
    chatId,
    chat,
    messageCount: 0,
    memberCount: members.get(chatId) ?? 0,
    lastMessageAt: null,
  });
  const byId = new Map<string, SourceChatListing>();
  for (const row of aggregates) {
    byId.set(row.chatId, {
      ...blank(row.chatId, null),
      messageCount: Number(row.messageCount),
      lastMessageAt: row.lastMessageAt,
    });
  }
  for (const chat of chatRows) {
    const existing = byId.get(chat.chatId);
    if (existing) {
      existing.chat = chat;
    } else {
      byId.set(chat.chatId, blank(chat.chatId, chat));
    }
  }
  return [...byId.values()].sort(
    (a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0),
  );
}

/** One roster entry: the user row plus when they were seen in this chat. */
export interface SourceChatMemberListing {
  user: SourceUserRow;
  memberSinceAt: Date;
  lastSeenAt: Date;
}

/** A chat's roster with membership times, oldest member first. */
export async function listSourceChatMemberListings(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceChatMemberListing[]> {
  return db
    .select({
      user: sourceUsers,
      memberSinceAt: sourceChatMembers.firstSeenAt,
      lastSeenAt: sourceChatMembers.lastSeenAt,
    })
    .from(sourceChatMembers)
    .innerJoin(
      sourceUsers,
      and(
        eq(sourceChatMembers.source, sourceUsers.source),
        eq(sourceChatMembers.userId, sourceUsers.userId),
      ),
    )
    .where(and(eq(sourceChatMembers.source, source), eq(sourceChatMembers.chatId, chatId)))
    .orderBy(asc(sourceChatMembers.firstSeenAt));
}

/** Set (or clear) a group's operator notes. Null when the chat is unknown. */
export async function updateSourceChatNotes(
  source: SourceId,
  chatId: string,
  notes: string | null,
  db: StoreDb = getStoreDb(),
): Promise<SourceChatRow | null> {
  const rows = await db
    .update(sourceChats)
    .set({ notes, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a group's reply language. Null when the chat is unknown. */
export async function updateSourceChatLanguage(
  source: SourceId,
  chatId: string,
  language: string | null,
  db: StoreDb = getStoreDb(),
): Promise<SourceChatRow | null> {
  const rows = await db
    .update(sourceChats)
    .set({ language, updatedAt: new Date() })
    .where(and(eq(sourceChats.source, source), eq(sourceChats.chatId, chatId)))
    .returning();
  return rows[0] ?? null;
}

/** One chat's full mirror, oldest first (the dashboard's history detail). */
export async function listSourceChatMessages(
  source: SourceId,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow[]> {
  return db
    .select()
    .from(sourceMessages)
    .where(and(eq(sourceMessages.source, source), eq(sourceMessages.chatId, chatId)))
    .orderBy(asc(sourceMessages.id));
}

/** Specific mirror rows by their source-local ids, insertion order, as stored. */
export async function getSourceMessagesByIds(
  source: SourceId,
  chatId: string,
  sourceMessageIds: string[],
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow[]> {
  if (sourceMessageIds.length === 0) return [];
  return db
    .select()
    .from(sourceMessages)
    .where(
      and(
        eq(sourceMessages.source, source),
        eq(sourceMessages.chatId, chatId),
        inArray(sourceMessages.sourceMessageId, sourceMessageIds),
      ),
    )
    .orderBy(asc(sourceMessages.id));
}

/**
 * Mirror rows sent within a window, insertion order, as stored. The end is
 * inclusive for user-facing range reads and exclusive for calendar-day
 * reads (a day ends exactly where the next begins).
 */
export async function getSourceMessagesInWindow(
  source: SourceId,
  chatId: string,
  window: { from: Date; to: Date; endExclusive: boolean },
  db: StoreDb = getStoreDb(),
): Promise<SourceMessageRow[]> {
  return db
    .select()
    .from(sourceMessages)
    .where(
      and(
        eq(sourceMessages.source, source),
        eq(sourceMessages.chatId, chatId),
        gte(sourceMessages.sentAt, window.from),
        window.endExclusive
          ? lt(sourceMessages.sentAt, window.to)
          : lte(sourceMessages.sentAt, window.to),
      ),
    )
    .orderBy(asc(sourceMessages.id));
}

/**
 * Append many mirror rows in one statement, skipping any whose dedupe key
 * already exists — the CSV import's write path. Returns how many were
 * actually inserted. Rows import into the shared stream (no assistant
 * dimension — historical content predates per-assistant streams).
 */
export async function appendSourceMessagesBulk(
  source: SourceId,
  values: readonly {
    chatId: string;
    sourceMessageId: string;
    role: "user" | "assistant";
    userId: string | null;
    content: string;
    replyToSourceMessageId: string | null;
    sentAt: Date;
    editedAt: Date | null;
    deletedAt: Date | null;
  }[],
  db: StoreDb = getStoreDb(),
): Promise<number> {
  if (values.length === 0) return 0;
  const rows = await db
    .insert(sourceMessages)
    .values(
      values.map((v) => ({
        ...v,
        source,
        assistantId: null,
        dedupeKey: messageDedupeKey({ chatId: v.chatId, sourceMessageId: v.sourceMessageId }),
        processed: true,
      })),
    )
    .onConflictDoNothing({ target: [sourceMessages.source, sourceMessages.dedupeKey] })
    .returning({ id: sourceMessages.id });
  return rows.length;
}
