import "server-only";

import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import { webMedia, webMediaBlobs, webMessages } from "../../../store/schema";

/**
 * Media in the web-chat tables: an image, a voice note, or a produced file
 * attached to one message, stored as ordered frames the way the tg store
 * does, so the vision pipeline treats both sources alike.
 *
 * **One deliberate difference from tg: the bytes stay.** Telegram is its own
 * archive — a described photo can be dropped there because the chat still
 * shows it. A web thread has no such archive: dropping the bytes would erase
 * the picture the operator is looking at. They are already bounded (a
 * normalized JPEG, at most ~900KB and usually far less), so the thread keeps
 * showing what was sent.
 */

/** A stored media row with its payload assembled from the frames. */
export interface StoredWebMedia {
  id: string;
  /** The thread the owning message belongs to (the contract's `chatId`). */
  threadId: string;
  messageId: number;
  kind: string;
  mimeType: string | null;
  description: string | null;
  status: string;
  frames: string[];
  createdAt: Date;
  describedAt: Date | null;
}

type MediaRow = typeof webMedia.$inferSelect;

async function withFrames(db: StoreDb, row: MediaRow, threadId: string): Promise<StoredWebMedia> {
  const blobs = await db
    .select()
    .from(webMediaBlobs)
    .where(eq(webMediaBlobs.mediaId, row.id))
    .orderBy(asc(webMediaBlobs.frameIndex));
  return {
    id: row.id,
    threadId,
    messageId: row.messageId,
    kind: row.kind,
    mimeType: row.mimeType,
    description: row.description,
    status: row.status,
    frames: blobs.map((blob) => blob.data.toString("base64")),
    createdAt: row.createdAt,
    describedAt: row.describedAt,
  };
}

/** The thread a message belongs to, or null when the message is unknown. */
async function threadOf(db: StoreDb, messageId: number): Promise<string | null> {
  const rows = await db
    .select({ threadId: webMessages.threadId })
    .from(webMessages)
    .where(eq(webMessages.id, messageId))
    .limit(1);
  return rows[0]?.threadId ?? null;
}

/** Attach media to a message. One row per message (the store's unique index). */
export async function insertMedia(
  values: {
    messageId: number;
    kind: string;
    mimeType: string | null;
    /** Ordered base64 payload — one image today, a frame sequence later. */
    frames: string[];
  },
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia | null> {
  const id = randomUUID();
  const inserted = await db
    .insert(webMedia)
    .values({
      id,
      messageId: values.messageId,
      kind: values.kind,
      mimeType: values.mimeType,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (!row) return null;
  if (values.frames.length > 0) {
    await db.insert(webMediaBlobs).values(
      values.frames.map((frame, frameIndex) => ({
        mediaId: id,
        frameIndex,
        data: Buffer.from(frame, "base64"),
      })),
    );
  }
  const threadId = (await threadOf(db, values.messageId)) ?? "";
  return withFrames(db, row, threadId);
}

export async function getMediaById(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia | null> {
  const rows = await db.select().from(webMedia).where(eq(webMedia.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return withFrames(db, row, (await threadOf(db, row.messageId)) ?? "");
}

export async function getMediaByMessage(
  threadId: string,
  messageId: number,
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia | null> {
  const rows = await db
    .select({ media: webMedia, threadId: webMessages.threadId })
    .from(webMedia)
    .innerJoin(webMessages, eq(webMedia.messageId, webMessages.id))
    .where(and(eq(webMedia.messageId, messageId), eq(webMessages.threadId, threadId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return withFrames(db, row.media, row.threadId);
}

/**
 * Record a description. Returns the updated row, or null when the row was no
 * longer pending — a concurrent describe pass won, and its text stands (the
 * same contract the tg store serves).
 */
export async function markDescribed(
  id: string,
  description: string,
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia | null> {
  const updated = await db
    .update(webMedia)
    .set({ description, status: "described", describedAt: new Date() })
    .where(and(eq(webMedia.id, id), eq(webMedia.status, "pending")))
    .returning();
  const row = updated[0];
  if (!row) return null;
  // The frames are NOT dropped here — see the module note.
  return withFrames(db, row, (await threadOf(db, row.messageId)) ?? "");
}

/** The backfill's work list: pending rows, oldest first. */
export async function listPendingMediaRefs(
  limit: number,
  db: StoreDb = getStoreDb(),
): Promise<Array<{ id: string; threadId: string; messageId: number }>> {
  if (limit <= 0) return [];
  const rows = await db
    .select({ id: webMedia.id, messageId: webMedia.messageId, threadId: webMessages.threadId })
    .from(webMedia)
    .innerJoin(webMessages, eq(webMedia.messageId, webMessages.id))
    .where(eq(webMedia.status, "pending"))
    .orderBy(asc(webMedia.createdAt))
    .limit(limit);
  return rows;
}

export async function countPendingMedia(db: StoreDb = getStoreDb()): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(webMedia)
    .where(eq(webMedia.status, "pending"));
  return Number(row?.total ?? 0);
}

/** The newest media rows (the dashboard gallery), newest first. */
export async function listRecentMedia(
  limit: number,
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia[]> {
  const rows = await db
    .select({ media: webMedia, threadId: webMessages.threadId })
    .from(webMedia)
    .innerJoin(webMessages, eq(webMedia.messageId, webMessages.id))
    .orderBy(desc(webMedia.createdAt))
    .limit(limit);
  return Promise.all(rows.map((row) => withFrames(db, row.media, row.threadId)));
}

/**
 * The media attached to the given messages, keyed by message id — without
 * the bytes: a transcript line needs the kind and the description, and the
 * picture itself is fetched by id when it is actually rendered.
 */
export async function getMediaForMessages(
  messageIds: number[],
  db: StoreDb = getStoreDb(),
): Promise<Map<number, { id: string; kind: string; status: string; description: string | null }>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: webMedia.id,
      messageId: webMedia.messageId,
      kind: webMedia.kind,
      status: webMedia.status,
      description: webMedia.description,
    })
    .from(webMedia)
    .where(inArray(webMedia.messageId, messageIds));
  return new Map(rows.map((row) => [row.messageId, row]));
}

/**
 * Store media that needs no describing: the assistant's own voice reply (its
 * words are the message's text) or a produced file. Born `described`, so the
 * backfill never goes looking at something nobody needs read.
 */
export async function describeOnInsert(
  values: {
    messageId: number;
    kind: string;
    mimeType: string | null;
    frames: string[];
    description: string;
  },
  db: StoreDb = getStoreDb(),
): Promise<StoredWebMedia | null> {
  const stored = await insertMedia(values, db);
  if (!stored) return null;
  const updated = await markDescribed(stored.id, values.description, db);
  return updated ?? stored;
}
