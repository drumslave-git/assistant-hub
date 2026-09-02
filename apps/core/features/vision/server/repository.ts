import "server-only";

import type { SourceId } from "@assistant-hub-swarm/contracts";
import { and, asc, count, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  sourceMedia,
  sourceMediaBlobs,
  sourceMessages,
} from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

import type { MediaAnnotation, MediaKind, MediaStatus } from "../types";

/**
 * Typed persistence for a transport's media — an adapter over the source
 * store's `source_media` + `source_media_blobs` rows. Every read and write
 * names the source whose rows it touches; message ids are the platform's
 * own, as text. This is the record shape the vision pipeline speaks
 * ({@link MediaRecord}); the live path reaches the same rows through
 * `server/source-store/media-port.ts`, this module serves the test
 * fixtures and the direct reads.
 *
 * Bytes live in `source_media_blobs` (real `bytea`, one row per frame, only
 * while the media row is `pending`); this module converts to/from the
 * base64 strings the rest of the app speaks, so callers never see Buffers.
 */

type MediaRow = typeof sourceMedia.$inferSelect;

/** A stored media row. */
export interface MediaRecord {
  id: string;
  /** The source whose chat this media was posted in. */
  source: SourceId;
  chatId: string;
  /** The platform's id of the message carrying the media. */
  sourceMessageId: string;
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

export interface InsertMedia {
  id: string;
  source: SourceId;
  chatId: string;
  sourceMessageId: string;
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
function mapRow(row: MediaRow, images: string[] = []): MediaRecord {
  return {
    id: row.id,
    source: row.source,
    chatId: row.chatId,
    sourceMessageId: row.sourceMessageId,
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
  db: StoreDb,
  mediaIds: string[],
): Promise<Map<string, string[]>> {
  const images = new Map<string, string[]>();
  if (mediaIds.length === 0) return images;
  const rows = await db
    .select()
    .from(sourceMediaBlobs)
    .where(inArray(sourceMediaBlobs.mediaId, mediaIds))
    .orderBy(asc(sourceMediaBlobs.mediaId), asc(sourceMediaBlobs.frameIndex));
  for (const row of rows) {
    const list = images.get(row.mediaId);
    if (list) list.push(row.data.toString("base64"));
    else images.set(row.mediaId, [row.data.toString("base64")]);
  }
  return images;
}

/**
 * Insert a pending media row. Idempotent on `(source, chat, message)` so a
 * re-delivered update does not duplicate. Returns the stored row, or null
 * when one existed.
 */
export async function insertMedia(db: StoreDb, values: InsertMedia): Promise<MediaRecord | null> {
  const images = values.frames && values.frames.length > 0 ? values.frames : [values.dataBase64];
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(sourceMedia)
      .values({
        id: values.id,
        source: values.source,
        chatId: values.chatId,
        sourceMessageId: values.sourceMessageId,
        kind: values.kind,
        fileId: values.fileId,
        fileUniqueId: values.fileUniqueId ?? null,
        mimeType: values.mimeType ?? "image/jpeg",
        visionHint: values.visionHint ?? null,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [sourceMedia.source, sourceMedia.chatId, sourceMedia.sourceMessageId],
      })
      .returning();
    if (!row) return null;
    await tx.insert(sourceMediaBlobs).values(
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
  db: StoreDb,
  values: Omit<InsertMedia, "dataBase64">,
): Promise<MediaRecord | null> {
  const [row] = await db
    .insert(sourceMedia)
    .values({
      id: values.id,
      source: values.source,
      chatId: values.chatId,
      sourceMessageId: values.sourceMessageId,
      kind: values.kind,
      fileId: values.fileId,
      fileUniqueId: values.fileUniqueId ?? null,
      mimeType: null,
      visionHint: values.visionHint ?? null,
      status: "unavailable",
    })
    .onConflictDoNothing({
      target: [sourceMedia.source, sourceMedia.chatId, sourceMedia.sourceMessageId],
    })
    .returning();
  return row ? mapRow(row) : null;
}

/** A row plus its frames — only a pending row can have any, so skip the query otherwise. */
async function withImages(db: StoreDb, row: MediaRow): Promise<MediaRecord> {
  const images =
    row.status === "pending" ? ((await loadImagesByMediaId(db, [row.id])).get(row.id) ?? []) : [];
  return mapRow(row, images);
}

/** The media row for a specific message (bytes included while pending), or null. */
export async function getMediaByMessage(
  db: StoreDb,
  source: SourceId,
  chatId: string,
  sourceMessageId: string,
): Promise<MediaRecord | null> {
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
  return rows[0] ? withImages(db, rows[0]) : null;
}

/** One media row by id (bytes included while pending), or null. Ids are unique across sources. */
export async function getMediaById(db: StoreDb, id: string): Promise<MediaRecord | null> {
  const rows = await db.select().from(sourceMedia).where(eq(sourceMedia.id, id)).limit(1);
  return rows[0] ? withImages(db, rows[0]) : null;
}

/**
 * Record a description on a media row and drop its bytes (blob rows deleted,
 * `status` → described). Returns the updated row, or null when it was already
 * described (so a concurrent/duplicate describe is a no-op). Scoped to a pending
 * row so we never overwrite a prior description.
 */
export async function markDescribed(
  db: StoreDb,
  id: string,
  description: string,
): Promise<MediaRecord | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(sourceMedia)
      .set({
        description,
        status: "described",
        describedAt: new Date(),
      })
      .where(and(eq(sourceMedia.id, id), eq(sourceMedia.status, "pending")))
      .returning();
    if (!row) return null;
    await tx.delete(sourceMediaBlobs).where(eq(sourceMediaBlobs.mediaId, id));
    return mapRow(row);
  });
}

/**
 * Media annotations for a set of messages in a chat, keyed by the platform's
 * message id — how each media message reads in the history transcript.
 */
export async function getMediaAnnotations(
  db: StoreDb,
  source: SourceId,
  chatId: string,
  sourceMessageIds: readonly string[],
): Promise<Map<string, MediaAnnotation>> {
  if (sourceMessageIds.length === 0) return new Map();
  const rows = await db
    .select({
      sourceMessageId: sourceMedia.sourceMessageId,
      kind: sourceMedia.kind,
      status: sourceMedia.status,
      description: sourceMedia.description,
    })
    .from(sourceMedia)
    .where(
      and(
        eq(sourceMedia.source, source),
        eq(sourceMedia.chatId, chatId),
        inArray(sourceMedia.sourceMessageId, [...sourceMessageIds]),
      ),
    );
  return new Map(
    rows.map((r) => [
      r.sourceMessageId,
      { kind: r.kind as MediaKind, status: r.status as MediaStatus, description: r.description },
    ]),
  );
}

/**
 * Recent media rows of one source for the dashboard, newest first. The scan
 * itself never touches bytes; frames are then fetched in one query for just
 * the pending rows — the only ones whose preview is rendered.
 */
export async function listRecentMedia(
  db: StoreDb,
  source: SourceId,
  limit = 100,
): Promise<MediaRecord[]> {
  const rows = await db
    .select()
    .from(sourceMedia)
    .where(eq(sourceMedia.source, source))
    .orderBy(desc(sourceMedia.createdAt))
    .limit(limit);
  const pendingIds = rows.filter((row) => row.status === "pending").map((row) => row.id);
  const images = await loadImagesByMediaId(db, pendingIds);
  return rows.map((row) => mapRow(row, images.get(row.id) ?? []));
}

/** What the backfill needs to re-describe a pending row — no bytes. */
export interface PendingMediaRef {
  id: string;
  chatId: string;
  sourceMessageId: string;
}

/**
 * How long a message's live-processing hold is honored. No reply pipeline
 * legitimately runs this long, so a `processed = false` older than this means
 * the pipeline died before its `finally` released the hold — the row must
 * become backfill-eligible again rather than stay hidden forever.
 */
const LIVE_HOLD_TIMEOUT = sql`now() - interval '10 minutes'`;

/**
 * Oldest pending media rows of one source, for the vision backfill job.
 * Oldest-first so the backlog drains in arrival order. Deliberately
 * byte-free: `describeAndStore` re-reads each row (with bytes) when its turn
 * comes.
 *
 * Rows whose message is still held by the live reply pipeline
 * (`source_messages.processed = false`) are excluded — backfill only ever
 * picks up leftovers, never work in flight — unless the hold has clearly
 * expired (crashed pipeline). A DM message may mirror into several
 * per-assistant streams, hence the DISTINCT.
 */
export async function listPendingMedia(
  db: StoreDb,
  source: SourceId,
  limit = 20,
): Promise<PendingMediaRef[]> {
  const rows = await db
    .select({
      id: sourceMedia.id,
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
    .limit(limit * 2);
  const seen = new Set<string>();
  const out: PendingMediaRef[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push({ id: row.id, chatId: row.chatId, sourceMessageId: row.sourceMessageId });
    if (out.length >= limit) break;
  }
  return out;
}

/** How many of one source's media rows are still awaiting a description. */
export async function countPendingMedia(db: StoreDb, source: SourceId): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(sourceMedia)
    .where(and(eq(sourceMedia.source, source), eq(sourceMedia.status, "pending")));
  return row?.value ?? 0;
}
