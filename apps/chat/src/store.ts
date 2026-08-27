import { and, asc, count, desc, eq, inArray, isNull, max } from "drizzle-orm";

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
