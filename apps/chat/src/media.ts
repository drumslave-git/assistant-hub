import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import type { ChatDb } from "./db";
import { media, mediaBlobs, messages } from "../store/schema";

/**
 * Media in this app's store: an image (later a voice note) attached to one
 * message, stored as ordered frames the way the tg store does, so the core's
 * vision pipeline treats both sources alike — it reads a pending row's bytes
 * over the internal API and writes the description back.
 *
 * **One deliberate difference from tg: the bytes stay.** Telegram is its own
 * archive — a described photo can be dropped there because the chat still
 * shows it. A web thread has no such archive: dropping the bytes would erase
 * the picture the operator is looking at. They are already bounded (a
 * normalized JPEG, at most ~900KB and usually far less), so the thread keeps
 * showing what was sent.
 */

/** A stored media row with its payload assembled from the frames. */
export interface StoredChatMedia {
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

type MediaRow = typeof media.$inferSelect;

async function withFrames(
  db: ChatDb,
  row: MediaRow,
  threadId: string,
): Promise<StoredChatMedia> {
  const blobs = await db
    .select()
    .from(mediaBlobs)
    .where(eq(mediaBlobs.mediaId, row.id))
    .orderBy(asc(mediaBlobs.frameIndex));
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
async function threadOf(db: ChatDb, messageId: number): Promise<string | null> {
  const rows = await db
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return rows[0]?.threadId ?? null;
}

/** Attach media to a message. One row per message (the store's unique index). */
export async function insertMedia(
  db: ChatDb,
  values: {
    messageId: number;
    kind: string;
    mimeType: string | null;
    /** Ordered base64 payload — one image today, a frame sequence later. */
    frames: string[];
  },
): Promise<StoredChatMedia | null> {
  const id = randomUUID();
  const inserted = await db
    .insert(media)
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
    await db.insert(mediaBlobs).values(
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

export async function getMediaById(db: ChatDb, id: string): Promise<StoredChatMedia | null> {
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return withFrames(db, row, (await threadOf(db, row.messageId)) ?? "");
}

export async function getMediaByMessage(
  db: ChatDb,
  threadId: string,
  messageId: number,
): Promise<StoredChatMedia | null> {
  const rows = await db
    .select({ media, threadId: messages.threadId })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .where(and(eq(media.messageId, messageId), eq(messages.threadId, threadId)))
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
  db: ChatDb,
  id: string,
  description: string,
): Promise<StoredChatMedia | null> {
  const updated = await db
    .update(media)
    .set({ description, status: "described", describedAt: new Date() })
    .where(and(eq(media.id, id), eq(media.status, "pending")))
    .returning();
  const row = updated[0];
  if (!row) return null;
  // The frames are NOT dropped here — see the module note.
  return withFrames(db, row, (await threadOf(db, row.messageId)) ?? "");
}

/** The backfill's work list: pending rows, oldest first. */
export async function listPendingMediaRefs(
  db: ChatDb,
  limit: number,
): Promise<Array<{ id: string; threadId: string; messageId: number }>> {
  if (limit <= 0) return [];
  const rows = await db
    .select({ id: media.id, messageId: media.messageId, threadId: messages.threadId })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .where(eq(media.status, "pending"))
    .orderBy(asc(media.createdAt))
    .limit(limit);
  return rows;
}

export async function countPendingMedia(db: ChatDb): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(media)
    .where(eq(media.status, "pending"));
  return Number(row?.total ?? 0);
}

/** The newest media rows (the dashboard gallery), newest first. */
export async function listRecentMedia(db: ChatDb, limit: number): Promise<StoredChatMedia[]> {
  const rows = await db
    .select({ media, threadId: messages.threadId })
    .from(media)
    .innerJoin(messages, eq(media.messageId, messages.id))
    .orderBy(desc(media.createdAt))
    .limit(limit);
  return Promise.all(rows.map((row) => withFrames(db, row.media, row.threadId)));
}

/**
 * The media attached to the given messages, keyed by message id — without
 * the bytes: a transcript line needs the kind and the description, and the
 * picture itself is fetched by id when it is actually rendered.
 */
export async function getMediaForMessages(
  db: ChatDb,
  messageIds: number[],
): Promise<Map<number, { id: string; kind: string; status: string; description: string | null }>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select({
      id: media.id,
      messageId: media.messageId,
      kind: media.kind,
      status: media.status,
      description: media.description,
    })
    .from(media)
    .where(inArray(media.messageId, messageIds));
  return new Map(rows.map((row) => [row.messageId, row]));
}

/**
 * Store media that needs no describing: the assistant's own voice reply (its
 * words are the message's text) or a produced file. Born `described`, so the
 * backfill never goes looking at something nobody needs read.
 */
export async function describeOnInsert(
  db: ChatDb,
  values: {
    messageId: number;
    kind: string;
    mimeType: string | null;
    frames: string[];
    description: string;
  },
): Promise<StoredChatMedia | null> {
  const stored = await insertMedia(db, values);
  if (!stored) return null;
  const updated = await markDescribed(db, stored.id, values.description);
  return updated ?? stored;
}
