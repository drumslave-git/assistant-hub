import { and, asc, eq } from "drizzle-orm";

import { media, mediaBlobs } from "../../store/schema";
import type { TgDb } from "../db";
import type { StoredMedia } from "./types";

/**
 * Media persistence in this app's store — the tg half of the v1 vision
 * repository: rows in `media`, pending payloads as ordered frames in
 * `media_blobs` (a still image is one frame, a video its sampled sequence,
 * a voice message its raw audio as frame 0). Describing is the core's job,
 * done over the internal API; `markDescribed` is where the
 * describe-then-drop lifecycle lands.
 */

type MediaRow = typeof media.$inferSelect;

async function withFrames(db: TgDb, row: MediaRow): Promise<StoredMedia> {
  const blobs =
    row.status === "pending"
      ? await db
          .select()
          .from(mediaBlobs)
          .where(eq(mediaBlobs.mediaId, row.id))
          .orderBy(asc(mediaBlobs.frameIndex))
      : [];
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
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
 * `(chat_id, telegram_message_id)` — a re-delivered update returns null and
 * the caller re-reads the existing row.
 */
export async function insertMedia(
  db: TgDb,
  values: {
    id: string;
    chatId: string;
    telegramMessageId: number;
    kind: string;
    fileId: string;
    fileUniqueId: string | null;
    mimeType: string | null;
    visionHint: string | null;
    /** Ordered base64 payload — frames for video, one image, or raw audio. */
    frames: string[];
  },
): Promise<StoredMedia | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(media)
      .values({
        id: values.id,
        chatId: values.chatId,
        telegramMessageId: values.telegramMessageId,
        kind: values.kind,
        fileId: values.fileId,
        fileUniqueId: values.fileUniqueId,
        mimeType: values.mimeType ?? "image/jpeg",
        visionHint: values.visionHint,
        status: "pending",
      })
      .onConflictDoNothing({ target: [media.chatId, media.telegramMessageId] })
      .returning();
    const row = rows[0];
    if (!row) return null;
    if (values.frames.length > 0) {
      await tx.insert(mediaBlobs).values(
        values.frames.map((base64, frameIndex) => ({
          mediaId: row.id,
          frameIndex,
          data: Buffer.from(base64, "base64"),
        })),
      );
    }
    return withFrames(tx as unknown as TgDb, row);
  });
}

/** Record media that could not be loaded — never re-attempted, never lost. */
export async function insertUnavailableMedia(
  db: TgDb,
  values: {
    id: string;
    chatId: string;
    telegramMessageId: number;
    kind: string;
    fileId: string;
    fileUniqueId: string | null;
    visionHint: string | null;
  },
): Promise<void> {
  await db
    .insert(media)
    .values({ ...values, status: "unavailable" })
    .onConflictDoNothing({ target: [media.chatId, media.telegramMessageId] });
}

export async function getMediaByMessage(
  db: TgDb,
  chatId: string,
  telegramMessageId: number,
): Promise<StoredMedia | null> {
  const rows = await db
    .select()
    .from(media)
    .where(and(eq(media.chatId, chatId), eq(media.telegramMessageId, telegramMessageId)))
    .limit(1);
  return rows[0] ? withFrames(db, rows[0]) : null;
}

export async function getMediaById(db: TgDb, id: string): Promise<StoredMedia | null> {
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1);
  return rows[0] ? withFrames(db, rows[0]) : null;
}

/**
 * Record a description and drop the bytes (blob rows deleted, status →
 * described). Scoped to a pending row so a prior description is never
 * overwritten; returns null when a concurrent pass already won.
 */
export async function markDescribed(
  db: TgDb,
  id: string,
  description: string,
): Promise<StoredMedia | null> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(media)
      .set({ description, status: "described", describedAt: new Date() })
      .where(and(eq(media.id, id), eq(media.status, "pending")))
      .returning();
    const row = rows[0];
    if (!row) return null;
    await tx.delete(mediaBlobs).where(eq(mediaBlobs.mediaId, id));
    return withFrames(tx as unknown as TgDb, row);
  });
}
