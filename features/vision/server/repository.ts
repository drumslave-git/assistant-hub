import "server-only";

import { and, asc, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { chatMessages, mediaBlobs, messageMedia, type MessageMediaRow } from "@/db/schema";

import type { MediaAnnotation, MediaKind, MediaStatus } from "../types";

/**
 * Typed persistence for `message_media` + `media_blobs`. Pure data access — no
 * policy, validation, or trace recording (the service owns those). Every function
 * takes a {@link DrizzleDb} so it runs against the pool or a test instance.
 *
 * Bytes live in `media_blobs` (real `bytea`, one row per frame, only while the
 * media row is `pending`); this module converts to/from the base64 strings the
 * rest of the app speaks (the vision model and the dashboard preview both want
 * base64 anyway), so callers never see `Buffer`s.
 */

/** A stored media row. */
export interface MediaRecord {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  fileId: string;
  fileUniqueId: string | null;
  mimeType: string | null;
  dataBase64: string | null;
  /** Video/GIF frames (base64, chronological); null for a single still image. */
  frames: string[] | null;
  visionHint: string | null;
  description: string | null;
  status: MediaStatus;
  createdAt: string;
  describedAt: string | null;
}

/** Fields for inserting a freshly ingested (pending) media row. */
export interface InsertMedia {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  fileId: string;
  fileUniqueId?: string | null;
  mimeType?: string | null;
  dataBase64: string;
  /**
   * Video/GIF frame sequence (base64, chronological). Omit for a still image.
   * When present it is the complete payload — `dataBase64` must be its first
   * frame (the preview), matching how ingestion builds both.
   */
  frames?: string[] | null;
  visionHint?: string | null;
}

/**
 * Map a media row plus its ordered frame payloads (base64) to the app-facing
 * record. `images` is empty for described/unavailable rows — bytes are gone.
 */
function mapRow(row: MessageMediaRow, images: string[] = []): MediaRecord {
  return {
    id: row.id,
    chatId: row.chatId,
    telegramMessageId: row.telegramMessageId,
    kind: row.kind as MediaKind,
    fileId: row.fileId,
    fileUniqueId: row.fileUniqueId,
    mimeType: row.mimeType,
    dataBase64: images[0] ?? null,
    frames: images.length > 1 ? images : null,
    visionHint: row.visionHint,
    description: row.description,
    status: row.status as MediaStatus,
    createdAt: row.createdAt.toISOString(),
    describedAt: row.describedAt ? row.describedAt.toISOString() : null,
  };
}

/**
 * The ordered base64 frames for each of the given media ids (one query for the
 * whole set). Ids without blob rows — described/unavailable media — are absent.
 */
async function loadImagesByMediaId(
  db: DrizzleDb,
  mediaIds: string[],
): Promise<Map<string, string[]>> {
  const images = new Map<string, string[]>();
  if (mediaIds.length === 0) return images;
  const rows = await db
    .select()
    .from(mediaBlobs)
    .where(inArray(mediaBlobs.mediaId, mediaIds))
    .orderBy(asc(mediaBlobs.mediaId), asc(mediaBlobs.frameIndex));
  for (const row of rows) {
    const list = images.get(row.mediaId);
    if (list) list.push(row.data.toString("base64"));
    else images.set(row.mediaId, [row.data.toString("base64")]);
  }
  return images;
}

/**
 * Insert a pending media row. Idempotent on `(chat_id, telegram_message_id)` so a
 * re-delivered update does not duplicate. Returns the stored row, or null when
 * one already existed.
 */
export async function insertMedia(db: DrizzleDb, values: InsertMedia): Promise<MediaRecord | null> {
  const images = values.frames && values.frames.length > 0 ? values.frames : [values.dataBase64];
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(messageMedia)
      .values({
        id: values.id,
        chatId: values.chatId,
        telegramMessageId: values.telegramMessageId,
        kind: values.kind,
        fileId: values.fileId,
        fileUniqueId: values.fileUniqueId ?? null,
        mimeType: values.mimeType ?? "image/jpeg",
        visionHint: values.visionHint ?? null,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [messageMedia.chatId, messageMedia.telegramMessageId],
      })
      .returning();
    if (!row) return null;
    await tx.insert(mediaBlobs).values(
      images.map((base64, frameIndex) => ({
        mediaId: row.id,
        frameIndex,
        data: Buffer.from(base64, "base64"),
      })),
    );
    return mapRow(row, images);
  });
}

/** Insert a placeholder row for media that could not be loaded/decoded. */
export async function insertUnavailableMedia(
  db: DrizzleDb,
  values: Omit<InsertMedia, "dataBase64">,
): Promise<MediaRecord | null> {
  const [row] = await db
    .insert(messageMedia)
    .values({
      id: values.id,
      chatId: values.chatId,
      telegramMessageId: values.telegramMessageId,
      kind: values.kind,
      fileId: values.fileId,
      fileUniqueId: values.fileUniqueId ?? null,
      mimeType: null,
      visionHint: values.visionHint ?? null,
      status: "unavailable",
    })
    .onConflictDoNothing({
      target: [messageMedia.chatId, messageMedia.telegramMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/** A row plus its frames — only a pending row can have any, so skip the query otherwise. */
async function withImages(db: DrizzleDb, row: MessageMediaRow): Promise<MediaRecord> {
  const images =
    row.status === "pending" ? ((await loadImagesByMediaId(db, [row.id])).get(row.id) ?? []) : [];
  return mapRow(row, images);
}

/** The media row for a specific message (bytes included while pending), or null. */
export async function getMediaByMessage(
  db: DrizzleDb,
  chatId: string,
  telegramMessageId: number,
): Promise<MediaRecord | null> {
  const row = await db.query.messageMedia.findFirst({
    where: and(
      eq(messageMedia.chatId, chatId),
      eq(messageMedia.telegramMessageId, telegramMessageId),
    ),
  });
  return row ? withImages(db, row) : null;
}

/** One media row by id (bytes included while pending), or null. */
export async function getMediaById(db: DrizzleDb, id: string): Promise<MediaRecord | null> {
  const row = await db.query.messageMedia.findFirst({ where: eq(messageMedia.id, id) });
  return row ? withImages(db, row) : null;
}

/**
 * Record a description on a media row and drop its bytes (blob rows deleted,
 * `status` → described). Returns the updated row, or null when it was already
 * described (so a concurrent/duplicate describe is a no-op). Scoped to a pending
 * row so we never overwrite a prior description.
 */
export async function markDescribed(
  db: DrizzleDb,
  id: string,
  description: string,
): Promise<MediaRecord | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(messageMedia)
      .set({
        description,
        status: "described",
        describedAt: new Date(),
      })
      .where(and(eq(messageMedia.id, id), eq(messageMedia.status, "pending")))
      .returning();
    if (!row) return null;
    await tx.delete(mediaBlobs).where(eq(mediaBlobs.mediaId, id));
    return mapRow(row);
  });
}

/**
 * Media annotations for a set of messages in a chat, keyed by Telegram message
 * id — how each media message reads in the history transcript.
 */
export async function getMediaAnnotations(
  db: DrizzleDb,
  chatId: string,
  telegramMessageIds: number[],
): Promise<Map<number, MediaAnnotation>> {
  if (telegramMessageIds.length === 0) return new Map();
  const rows = await db
    .select({
      telegramMessageId: messageMedia.telegramMessageId,
      kind: messageMedia.kind,
      status: messageMedia.status,
      description: messageMedia.description,
    })
    .from(messageMedia)
    .where(
      and(
        eq(messageMedia.chatId, chatId),
        inArray(messageMedia.telegramMessageId, telegramMessageIds),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.telegramMessageId,
      { kind: r.kind as MediaKind, status: r.status as MediaStatus, description: r.description },
    ]),
  );
}

/**
 * Recent media rows for the dashboard, newest first. The scan itself never
 * touches bytes (they live in `media_blobs`); frames are then fetched in one
 * query for just the pending rows — the only ones whose preview is rendered.
 */
export async function listRecentMedia(db: DrizzleDb, limit = 100): Promise<MediaRecord[]> {
  const rows = await db
    .select()
    .from(messageMedia)
    .orderBy(desc(messageMedia.createdAt))
    .limit(limit);
  const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
  const images = await loadImagesByMediaId(db, pendingIds);
  return rows.map((row) => mapRow(row, images.get(row.id) ?? []));
}

/** What the backfill needs to re-describe a pending row — no bytes. */
export interface PendingMediaRef {
  id: string;
  chatId: string;
  telegramMessageId: number;
}

/**
 * How long a message's live-processing hold is honored. No reply pipeline
 * legitimately runs this long, so a `processed = false` older than this means
 * the pipeline died before its `finally` released the hold — the row must
 * become backfill-eligible again rather than stay hidden forever.
 */
const LIVE_HOLD_TIMEOUT = sql`now() - interval '10 minutes'`;

/**
 * Oldest pending media rows, for the vision backfill job (priority 8).
 * Oldest-first so the backlog drains in arrival order. Deliberately byte-free:
 * `describeAndStore` re-reads each row (with bytes) when its turn comes, so the
 * batch scan never loads payloads it may not use.
 *
 * Rows whose message is still held by the live reply pipeline
 * (`chat_messages.processed = false`, see the semaphore column) are excluded —
 * backfill only ever picks up leftovers, never work in flight — unless the hold
 * has clearly expired (crashed pipeline).
 */
export async function listPendingMedia(db: DrizzleDb, limit = 20): Promise<PendingMediaRef[]> {
  return db
    .select({
      id: messageMedia.id,
      chatId: messageMedia.chatId,
      telegramMessageId: messageMedia.telegramMessageId,
    })
    .from(messageMedia)
    .innerJoin(
      chatMessages,
      and(
        eq(chatMessages.chatId, messageMedia.chatId),
        eq(chatMessages.telegramMessageId, messageMedia.telegramMessageId),
      ),
    )
    .where(
      and(
        eq(messageMedia.status, "pending"),
        or(eq(chatMessages.processed, true), lt(messageMedia.createdAt, LIVE_HOLD_TIMEOUT)),
      ),
    )
    .orderBy(asc(messageMedia.createdAt))
    .limit(limit);
}

/** How many media rows are still awaiting a description (backfill backlog size). */
export async function countPendingMedia(db: DrizzleDb): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(messageMedia)
    .where(eq(messageMedia.status, "pending"));
  return row?.value ?? 0;
}
