import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gte, inArray, isNull, max } from "drizzle-orm";

import type { ChatDb } from "./db";
import {
  media,
  messages,
  threads,
  users,
  type ChatMediaRow,
  type ChatMessageRow,
  type ChatUserRow,
  type ThreadRow,
} from "../store/schema";

/**
 * Reads and writes over the chat store — this app's own database, which
 * nothing else may touch (PLAN.md, "Data ownership"). The operator API maps
 * these rows onto the shared listing contract; the runtime halves (inbound,
 * delivery, media) use the same functions.
 *
 * A web thread is this source's conversation: one human, one assistant bound
 * at creation. That is why every listing here answers `kind: "direct"` —
 * there is no group shape to model.
 */

/** Every person this source knows, newest first. */
export async function listUsers(db: ChatDb): Promise<ChatUserRow[]> {
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function getUserById(db: ChatDb, userId: string): Promise<ChatUserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** Set a person's operator-curated aliases. Null when the user is unknown. */
export async function updateUserAliases(
  db: ChatDb,
  userId: string,
  aliases: string[],
): Promise<ChatUserRow | null> {
  const rows = await db
    .update(users)
    .set({ aliases, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a person's reply language. Null when the user is unknown. */
export async function updateUserLanguage(
  db: ChatDb,
  userId: string,
  language: string | null,
): Promise<ChatUserRow | null> {
  const rows = await db
    .update(users)
    .set({ language, updatedAt: new Date() })
    .where(eq(users.id, userId))
    .returning();
  return rows[0] ?? null;
}

/** One thread with the aggregates the dashboard listing shows. */
export interface ThreadListing {
  thread: ThreadRow;
  /** Messages in the thread, soft-deleted rows excluded. */
  messageCount: number;
  lastMessageAt: Date | null;
}

/**
 * Every thread this source carries, most recent first: by last message, and
 * by creation for a thread nobody has written in yet — a thread you just
 * started belongs at the top, and a listing that hid it entirely would read
 * as "the thread was not saved".
 */
export async function listThreadListings(db: ChatDb): Promise<ThreadListing[]> {
  const [threadRows, aggregates] = await Promise.all([
    db.select().from(threads),
    db
      .select({
        threadId: messages.threadId,
        messageCount: count(),
        lastMessageAt: max(messages.sentAt),
      })
      .from(messages)
      .where(isNull(messages.deletedAt))
      .groupBy(messages.threadId),
  ]);
  const byThread = new Map(aggregates.map((row) => [row.threadId, row]));
  return threadRows
    .map((thread) => {
      const aggregate = byThread.get(thread.id);
      return {
        thread,
        messageCount: Number(aggregate?.messageCount ?? 0),
        lastMessageAt: aggregate?.lastMessageAt ?? null,
      };
    })
    .sort(
      (a, b) =>
        (b.lastMessageAt?.getTime() ?? b.thread.createdAt.getTime()) -
        (a.lastMessageAt?.getTime() ?? a.thread.createdAt.getTime()),
    );
}

export async function getThreadListing(db: ChatDb, threadId: string): Promise<ThreadListing | null> {
  const listings = await listThreadListings(db);
  return listings.find((listing) => listing.thread.id === threadId) ?? null;
}

export async function getThreadById(db: ChatDb, threadId: string): Promise<ThreadRow | null> {
  const rows = await db.select().from(threads).where(eq(threads.id, threadId)).limit(1);
  return rows[0] ?? null;
}

/**
 * A thread's roster: its owner, and only its owner. The core is told about
 * exactly this person, so the dashboard shows exactly this person.
 */
export async function listThreadMembers(
  db: ChatDb,
  threadId: string,
): Promise<Array<{ user: ChatUserRow; memberSinceAt: Date; lastSeenAt: Date }>> {
  const rows = await db
    .select({ user: users, thread: threads })
    .from(threads)
    .innerJoin(users, eq(threads.userId, users.id))
    .where(eq(threads.id, threadId))
    .limit(1);
  const row = rows[0];
  if (!row) return [];
  const [last] = await db
    .select({ lastSeenAt: max(messages.sentAt) })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, "user")));
  return [
    {
      user: row.user,
      memberSinceAt: row.thread.createdAt,
      lastSeenAt: last?.lastSeenAt ?? row.thread.createdAt,
    },
  ];
}

/** Set (or clear) a thread's operator notes. Null when the thread is unknown. */
export async function updateThreadNotes(
  db: ChatDb,
  threadId: string,
  notes: string | null,
): Promise<ThreadRow | null> {
  const rows = await db
    .update(threads)
    .set({ notes, updatedAt: new Date() })
    .where(eq(threads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a thread's reply language. Null when the thread is unknown. */
export async function updateThreadLanguage(
  db: ChatDb,
  threadId: string,
  language: string | null,
): Promise<ThreadRow | null> {
  const rows = await db
    .update(threads)
    .set({ language, updatedAt: new Date() })
    .where(eq(threads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/** One thread's full transcript, oldest first (deleted rows included). */
export async function listThreadMessages(
  db: ChatDb,
  threadId: string,
): Promise<ChatMessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.id));
}

export async function getMessageById(
  db: ChatDb,
  threadId: string,
  messageId: number,
): Promise<ChatMessageRow | null> {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.id, messageId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The media rows attached to the given messages, keyed by message id. */
export async function getMediaForMessages(
  db: ChatDb,
  messageIds: number[],
): Promise<Map<number, ChatMediaRow>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.select().from(media).where(inArray(media.messageId, messageIds));
  return new Map(rows.map((row) => [row.messageId, row]));
}

/**
 * The operator's own chat user. Single-operator system (PLAN.md): the
 * dashboard acts as one web identity, created on first use and linkable to
 * the operator's other identities through core-store person links — which is
 * where their real name lives. The name here is deliberately a role, not a
 * guess at who they are.
 */
export const OPERATOR_USER_NAME = "Operator";

export async function getOrCreateOperatorUser(db: ChatDb): Promise<ChatUserRow> {
  const existing = await db.select().from(users).where(eq(users.isOperator, true)).limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db
    .insert(users)
    .values({ id: randomUUID(), name: OPERATOR_USER_NAME, isOperator: true })
    .returning();
  return inserted[0];
}

/** The name a thread wears until it has been said something worth naming. */
export const PROVISIONAL_THREAD_NAME = "New chat";

/**
 * Start a thread, bound to one assistant for good (PLAN.md). Nameless by
 * default: the thread carries a placeholder and says so, and the core names
 * it from the first exchange.
 */
export async function createThread(
  db: ChatDb,
  input: { userId: string; assistantId: string; name?: string | null },
): Promise<ThreadRow> {
  const name = input.name?.trim();
  const rows = await db
    .insert(threads)
    .values({
      id: randomUUID(),
      userId: input.userId,
      assistantId: input.assistantId,
      name: name || PROVISIONAL_THREAD_NAME,
      titleProvisional: !name,
    })
    .returning();
  return rows[0];
}

/**
 * Rename a thread. Null when it is gone. The assistant never changes, and the
 * name stops being provisional — a name someone chose is not a placeholder.
 */
export async function renameThread(
  db: ChatDb,
  threadId: string,
  name: string,
): Promise<ThreadRow | null> {
  const rows = await db
    .update(threads)
    .set({ name, titleProvisional: false, updatedAt: new Date() })
    .where(eq(threads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/**
 * The core's answer to `titleProvisional`: name the thread from what was said
 * in it. Only ever applied to a thread still wearing its placeholder, so a
 * name the operator chose in the meantime wins over a late-arriving one.
 */
export async function setGeneratedTitle(
  db: ChatDb,
  threadId: string,
  name: string,
): Promise<ThreadRow | null> {
  const rows = await db
    .update(threads)
    .set({ name, titleProvisional: false, updatedAt: new Date() })
    .where(and(eq(threads.id, threadId), eq(threads.titleProvisional, true)))
    .returning();
  return rows[0] ?? null;
}

/** Delete a thread and everything in it (the transcript cascades). */
export async function deleteThread(db: ChatDb, threadId: string): Promise<boolean> {
  const rows = await db.delete(threads).where(eq(threads.id, threadId)).returning();
  return rows.length > 0;
}

/** Append one line to a thread's transcript; the store assigns the id. */
export async function appendMessage(
  db: ChatDb,
  input: {
    threadId: string;
    role: "user" | "assistant";
    content: string;
    sentAt?: Date;
    replyToMessageId?: number | null;
  },
): Promise<ChatMessageRow> {
  const rows = await db
    .insert(messages)
    .values({
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      sentAt: input.sentAt ?? new Date(),
      replyToMessageId: input.replyToMessageId ?? null,
    })
    .returning();
  return rows[0];
}

/**
 * Retract a delivered message (the outbound port's delete — a browsing
 * acknowledgement replaced by the real answer). Soft: the row stays so ids
 * never dangle. False when there was nothing to retract.
 */
export async function markMessageDeleted(
  db: ChatDb,
  threadId: string,
  messageId: number,
): Promise<boolean> {
  const rows = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.id, messageId),
        isNull(messages.deletedAt),
      ),
    )
    .returning();
  return rows.length > 0;
}

/** A thread's live transcript (deleted rows excluded), oldest first. */
export async function listLiveMessages(
  db: ChatDb,
  threadId: string,
): Promise<ChatMessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.threadId, threadId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.id));
}

/**
 * The messages of a thread since `since`, for the context window — deleted
 * rows and the turn's own message excluded, insertion order.
 */
export async function getMessagesSince(
  db: ChatDb,
  threadId: string,
  since: Date,
  options: { excludeMessageId?: number } = {},
): Promise<ChatMessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        isNull(messages.deletedAt),
        gte(messages.sentAt, since),
      ),
    )
    .orderBy(asc(messages.id));
  return options.excludeMessageId == null
    ? rows
    : rows.filter((row) => row.id !== options.excludeMessageId);
}
