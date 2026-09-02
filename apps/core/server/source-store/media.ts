import "server-only";

import { and, asc, count, desc, eq, lt, or, sql } from "drizzle-orm";
import type { SourceId } from "@assistant-hub-swarm/contracts";

import { getStoreDb, type StoreDb } from "@/server/store/db";

import { sourceMedia, sourceMediaBlobs, sourceMessages } from "../../store/schema";

/**
 * Transport media in the conversation store — the former tg media store,
 * source-parameterized: rows in `source_media`, pending payloads as ordered
 * frames in `source_media_blobs` (a still image is one frame, a video its
 * sampled sequence, a voice message its raw audio as frame 0). Describing is
 * the vision/voice features' job; `markSourceMediaDescribed` is where the
 * describe-then-drop lifecycle lands — the platform is its own archive, so
 * described bytes go (unlike the web chat's, which have no other home).
 */

/** A stored media row with its payload assembled from the frames. */
export interface StoredSourceMedia {
  id: string;
  source: SourceId;
  chatId: string;
  sourceMessageId: string;
  kind: string;
  fileId: string;
  fileUniqueId: string | null;
  mimeType: string | null;
  visionHint: string | null;
  description: string | null;
  status: string;
  frames: string[];
  createdAt: Date;
  describedAt: Date | null;
}

type MediaRow = typeof sourceMedia.$inferSelect;

async function withFrames(db: StoreDb, row: MediaRow): Promise<StoredSourceMedia> {
  const blobs =
    row.status === "pending"
      ? await db
          .select()
          .from(sourceMediaBlobs)
          .where(eq(sourceMediaBlobs.mediaId, row.id))
          .orderBy(asc(sourceMediaBlobs.frameIndex))
      : [];
  return {
    id: row.id,
    source: row.source as SourceId,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
    kind: row.kind,
    fileId: row.fileId,
    fileUniqueId: row.fileUniqueId,
    mimeType: row.mimeType,
    visionHint: row.visionHint,
    description: row.description,
    status: row.status,
    frames: blobs.map((blob) => blob.data.toString("base64")),
    createdAt: row.createdAt,
    describedAt: row.describedAt,
  };
}

/**
 * Store one media row with its pending payload. Idempotent on
 * `(source, chat, source message id)` — a re-delivered update returns null
 * and the caller re-reads the existing row.
 */
export async function insertSourceMedia(
  values: {
    id: string;
    source: SourceId;
    chatId: string;
    sourceMessageId: string;
    kind: string;
    fileId: string;
    fileUniqueId: string | null;
    mimeType: string | null;
    visionHint: string | null;
    /** Ordered base64 payload — frames for video, one image, or raw audio. */
    frames: string[];
  },
  db: StoreDb = getStoreDb(),
): Promise<StoredSourceMedia | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(sourceMedia)
      .values({
        id: values.id,
        source: values.source,
        chatId: values.chatId,
        sourceMessageId: values.sourceMessageId,
        kind: values.kind,
        fileId: values.fileId,
        fileUniqueId: values.fileUniqueId,
        mimeType: values.mimeType ?? "image/jpeg",
        visionHint: values.visionHint,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [sourceMedia.source, sourceMedia.chatId, sourceMedia.sourceMessageId],
      })
      .returning();
    const row = rows[0];
    if (!row) return null;
    if (values.frames.length > 0) {
      await tx.insert(sourceMediaBlobs).values(
        values.frames.map((base64, frameIndex) => ({
          mediaId: row.id,
          frameIndex,
          data: Buffer.from(base64, "base64"),
        })),
      );
    }
    return withFrames(tx as unknown as StoreDb, row);
  });
}

/** Record media that could not be loaded — never re-attempted, never lost. */
export async function insertUnavailableSourceMedia(
  values: {
    id: string;
    source: SourceId;
    chatId: string;
    sourceMessageId: string;
    kind: string;
    fileId: string;
    fileUniqueId: string | null;
    visionHint: string | null;
  },
  db: StoreDb = getStoreDb(),
): Promise<void> {
  await db
    .insert(sourceMedia)
    .values({ ...values, status: "unavailable" })
    .onConflictDoNothing({
      target: [sourceMedia.source, sourceMedia.chatId, sourceMedia.sourceMessageId],
    });
}

export async function getSourceMediaByMessage(
  source: SourceId,
  chatId: string,
  sourceMessageId: string,
  db: StoreDb = getStoreDb(),
): Promise<StoredSourceMedia | null> {
  const rows = await db
    .select()
    .from(sourceMedia)
    .where(
      and(
        eq(sourceMedia.source, source),
        eq(sourceMedia.chatId, chatId),
        eq(sourceMedia.sourceMessageId, sourceMessageId),
      ),
    )
    .limit(1);
  return rows[0] ? withFrames(db, rows[0]) : null;
}

export async function getSourceMediaById(
  id: string,
  db: StoreDb = getStoreDb(),
): Promise<StoredSourceMedia | null> {
  const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.id, id)).limit(1);
  return rows[0] ? withFrames(db, rows[0]) : null;
}

/**
 * A message's live-processing hold expires after this long: a turn that
 * crashed mid-run must not park its media out of the backfill's reach.
 */
const LIVE_HOLD_TIMEOUT = sql`now() - interval '10 minutes'`;

/** What the backfill needs to target a pending row — no bytes. */
export interface PendingSourceMediaRef {
  id: string;
  source: SourceId;
  chatId: string;
  sourceMessageId: string;
}

/**
 * Pending rows the backfill may claim, oldest first: media of messages not
 * currently held by a live turn (`source_messages.processed`), or held
 * longer than the timeout.
 */
export async function listPendingSourceMediaRefs(
  source: SourceId,
  limit = 20,
  db: StoreDb = getStoreDb(),
): Promise<PendingSourceMediaRef[]> {
  const rows = await db
    .select({
      id: sourceMedia.id,
      source: sourceMedia.source,
      chatId: sourceMedia.chatId,
      sourceMessageId: sourceMedia.sourceMessageId,
    })
    .from(sourceMedia)
    .innerJoin(
      sourceMessages,
      and(
        eq(sourceMessages.source, sourceMedia.source),
        eq(sourceMessages.chatId, sourceMedia.chatId),
        eq(sourceMessages.sourceMessageId, sourceMedia.sourceMessageId),
      ),
    )
    .where(
      and(
        eq(sourceMedia.source, source),
        eq(sourceMedia.status, "pending"),
        or(eq(sourceMessages.processed, true), lt(sourceMedia.createdAt, LIVE_HOLD_TIMEOUT)),
      ),
    )
    .orderBy(asc(sourceMedia.createdAt))
    .limit(limit);
  return rows.map((row) => ({ ...row, source: row.source as SourceId }));
}

/** Rows still awaiting a description (the backfill's backlog size). */
export async function countPendingSourceMedia(
  source: SourceId,
  db: StoreDb = getStoreDb(),
): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(sourceMedia)
    .where(and(eq(sourceMedia.source, source), eq(sourceMedia.status, "pending")));
  return row?.value ?? 0;
}

/**
 * The newest media rows (dashboard gallery), frames included for pending
 * rows only — a described row's bytes are gone by design.
 */
export async function listRecentSourceMedia(
  source: SourceId,
  limit = 100,
  db: StoreDb = getStoreDb(),
): Promise<StoredSourceMedia[]> {
  const rows = await db
    .select()
    .from(sourceMedia)
    .where(eq(sourceMedia.source, source))
    .orderBy(desc(sourceMedia.createdAt))
    .limit(limit);
  return Promise.all(rows.map((row) => withFrames(db, row)));
}

/**
 * Record a description and drop the bytes (blob rows deleted, status →
 * described). Scoped to a pending row so a prior description is never
 * overwritten; returns null when a concurrent pass already won.
 */
export async function markSourceMediaDescribed(
  id: string,
  description: string,
  db: StoreDb = getStoreDb(),
): Promise<StoredSourceMedia | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(sourceMedia)
      .set({ description, status: "described", describedAt: new Date() })
      .where(and(eq(sourceMedia.id, id), eq(sourceMedia.status, "pending")))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await tx.delete(sourceMediaBlobs).where(eq(sourceMediaBlobs.mediaId, id));
    return withFrames(tx as unknown as StoreDb, row);
  });
}
