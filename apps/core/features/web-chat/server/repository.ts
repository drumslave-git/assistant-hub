import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, count, eq, gte, inArray, isNull, max } from "drizzle-orm";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import {
  accounts,
  webMedia,
  webMessages,
  webThreads,
  type AccountRow,
  type WebMediaRow,
  type WebMessageRow,
  type WebThreadRow,
} from "../../../store/schema";

/**
 * Reads and writes over the web-chat tables — the former `apps/chat` store,
 * living in the core store since the chat dissolve (redesign Phase 6). The
 * service maps these rows onto the operator listing contract; the runtime
 * halves (inbound, delivery, media) use the same functions.
 *
 * A web thread is this source's conversation: one human, one assistant bound
 * at creation. That is why every listing here answers `kind: "direct"` —
 * there is no group shape to model.
 */

/**
 * The web chat's people ARE the accounts (Phase 8, web user = account):
 * `chat:user:<id>` is an account id, and the chat directory lists the
 * account roster. Oldest first, matching the account page.
 */
export async function listChatUsers(db: StoreDb = getStoreDb()): Promise<AccountRow[]> {
  return db.select().from(accounts).orderBy(asc(accounts.createdAt));
}

export async function getChatUserById(
  userId: string,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db.select().from(accounts).where(eq(accounts.id, userId)).limit(1);
  return rows[0] ?? null;
}

/** Set a person's curated aliases (on the account). Null when unknown. */
export async function updateChatUserAliases(
  userId: string,
  aliases: string[],
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db
    .update(accounts)
    .set({ aliases, updatedAt: new Date() })
    .where(eq(accounts.id, userId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a person's reply language (on the account). Null when unknown. */
export async function updateChatUserLanguage(
  userId: string,
  language: string | null,
  db: StoreDb = getStoreDb(),
): Promise<AccountRow | null> {
  const rows = await db
    .update(accounts)
    .set({ language, updatedAt: new Date() })
    .where(eq(accounts.id, userId))
    .returning();
  return rows[0] ?? null;
}

/** One thread with the aggregates the dashboard listing shows. */
export interface ThreadListing {
  thread: WebThreadRow;
  /** Messages in the thread, soft-deleted rows excluded. */
  messageCount: number;
  lastMessageAt: Date | null;
}

/**
 * Every thread, most recent first: by last message, and by creation for a
 * thread nobody has written in yet — a thread you just started belongs at the
 * top, and a listing that hid it entirely would read as "the thread was not
 * saved".
 */
export async function listThreadListings(
  db: StoreDb = getStoreDb(),
  options: { forAccountId?: string } = {},
): Promise<ThreadListing[]> {
  const [threadRows, aggregates] = await Promise.all([
    options.forAccountId
      ? db.select().from(webThreads).where(eq(webThreads.userId, options.forAccountId))
      : db.select().from(webThreads),
    db
      .select({
        threadId: webMessages.threadId,
        messageCount: count(),
        lastMessageAt: max(webMessages.sentAt),
      })
      .from(webMessages)
      .where(isNull(webMessages.deletedAt))
      .groupBy(webMessages.threadId),
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

export async function getThreadListing(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<ThreadListing | null> {
  const listings = await listThreadListings(db);
  return listings.find((listing) => listing.thread.id === threadId) ?? null;
}

export async function getThreadById(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow | null> {
  const rows = await db.select().from(webThreads).where(eq(webThreads.id, threadId)).limit(1);
  return rows[0] ?? null;
}

/**
 * A thread's roster: its owner, and only its owner. The pipeline is told
 * about exactly this person, so the dashboard shows exactly this person.
 */
export async function listThreadMembers(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<Array<{ user: AccountRow; memberSinceAt: Date; lastSeenAt: Date }>> {
  const rows = await db
    .select({ user: accounts, thread: webThreads })
    .from(webThreads)
    .innerJoin(accounts, eq(webThreads.userId, accounts.id))
    .where(eq(webThreads.id, threadId))
    .limit(1);
  const row = rows[0];
  if (!row) return [];
  const [last] = await db
    .select({ lastSeenAt: max(webMessages.sentAt) })
    .from(webMessages)
    .where(and(eq(webMessages.threadId, threadId), eq(webMessages.role, "user")));
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
  threadId: string,
  notes: string | null,
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow | null> {
  const rows = await db
    .update(webThreads)
    .set({ notes, updatedAt: new Date() })
    .where(eq(webThreads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/** Set (or clear) a thread's reply language. Null when the thread is unknown. */
export async function updateThreadLanguage(
  threadId: string,
  language: string | null,
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow | null> {
  const rows = await db
    .update(webThreads)
    .set({ language, updatedAt: new Date() })
    .where(eq(webThreads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/** One thread's full transcript, oldest first (deleted rows included). */
export async function listThreadMessages(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<WebMessageRow[]> {
  return db
    .select()
    .from(webMessages)
    .where(eq(webMessages.threadId, threadId))
    .orderBy(asc(webMessages.id));
}

export async function getMessageById(
  threadId: string,
  messageId: number,
  db: StoreDb = getStoreDb(),
): Promise<WebMessageRow | null> {
  const rows = await db
    .select()
    .from(webMessages)
    .where(and(eq(webMessages.threadId, threadId), eq(webMessages.id, messageId)))
    .limit(1);
  return rows[0] ?? null;
}

/** The media rows attached to the given messages, keyed by message id. */
export async function getMediaRowsForMessages(
  messageIds: number[],
  db: StoreDb = getStoreDb(),
): Promise<Map<number, WebMediaRow>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db.select().from(webMedia).where(inArray(webMedia.messageId, messageIds));
  return new Map(rows.map((row) => [row.messageId, row]));
}

/** The name a thread wears until it has been said something worth naming. */
export const PROVISIONAL_THREAD_NAME = "New chat";

/**
 * Start a thread, bound to one assistant for good (PLAN.md). Nameless by
 * default: the thread carries a placeholder and says so, and the pipeline
 * names it from the first exchange.
 */
export async function createThread(
  input: { userId: string; assistantId: string; name?: string | null },
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow> {
  const name = input.name?.trim();
  const rows = await db
    .insert(webThreads)
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
  threadId: string,
  name: string,
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow | null> {
  const rows = await db
    .update(webThreads)
    .set({ name, titleProvisional: false, updatedAt: new Date() })
    .where(eq(webThreads.id, threadId))
    .returning();
  return rows[0] ?? null;
}

/**
 * The pipeline's answer to `titleProvisional`: name the thread from what was
 * said in it. Only ever applied to a thread still wearing its placeholder, so
 * a name the operator chose in the meantime wins over a late-arriving one.
 */
export async function setGeneratedTitle(
  threadId: string,
  name: string,
  db: StoreDb = getStoreDb(),
): Promise<WebThreadRow | null> {
  const rows = await db
    .update(webThreads)
    .set({ name, titleProvisional: false, updatedAt: new Date() })
    .where(and(eq(webThreads.id, threadId), eq(webThreads.titleProvisional, true)))
    .returning();
  return rows[0] ?? null;
}

/** Delete a thread and everything in it (the transcript cascades). */
export async function deleteThread(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  const rows = await db.delete(webThreads).where(eq(webThreads.id, threadId)).returning();
  return rows.length > 0;
}

/** Append one line to a thread's transcript; the store assigns the id. */
export async function appendMessage(
  input: {
    threadId: string;
    role: "user" | "assistant";
    content: string;
    sentAt?: Date;
    replyToMessageId?: number | null;
  },
  db: StoreDb = getStoreDb(),
): Promise<WebMessageRow> {
  const rows = await db
    .insert(webMessages)
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
  threadId: string,
  messageId: number,
  db: StoreDb = getStoreDb(),
): Promise<boolean> {
  const rows = await db
    .update(webMessages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(webMessages.threadId, threadId),
        eq(webMessages.id, messageId),
        isNull(webMessages.deletedAt),
      ),
    )
    .returning();
  return rows.length > 0;
}

/** A thread's live transcript (deleted rows excluded), oldest first. */
export async function listLiveMessages(
  threadId: string,
  db: StoreDb = getStoreDb(),
): Promise<WebMessageRow[]> {
  return db
    .select()
    .from(webMessages)
    .where(and(eq(webMessages.threadId, threadId), isNull(webMessages.deletedAt)))
    .orderBy(asc(webMessages.id));
}

/**
 * The messages of a thread since `since`, for the context window — deleted
 * rows and the turn's own message excluded, insertion order.
 */
export async function getMessagesSince(
  threadId: string,
  since: Date,
  options: { excludeMessageId?: number } = {},
  db: StoreDb = getStoreDb(),
): Promise<WebMessageRow[]> {
  const rows = await db
    .select()
    .from(webMessages)
    .where(
      and(
        eq(webMessages.threadId, threadId),
        isNull(webMessages.deletedAt),
        gte(webMessages.sentAt, since),
      ),
    )
    .orderBy(asc(webMessages.id));
  return options.excludeMessageId == null
    ? rows
    : rows.filter((row) => row.id !== options.excludeMessageId);
}
