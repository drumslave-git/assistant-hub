import "server-only";

import type { SourceId } from "@assistant-hub/contracts";

import type { MediaRecord } from "@/features/vision/server/repository";
import type { MediaStorePort } from "@/features/vision/server/service";

import {
  countPendingSourceMedia,
  getSourceMediaById,
  getSourceMediaByMessage,
  listPendingSourceMediaRefs,
  listRecentSourceMedia,
  markSourceMediaDescribed,
  type StoredSourceMedia,
} from "./media";

/**
 * A transport's media as the vision pipeline's {@link MediaStorePort} —
 * direct store reads since the Phase 7 de-storing (this was the HTTP client
 * to the source app's media API). The describe/transcribe passes read a
 * pending row's bytes here and write the text back; the bytes are dropped on
 * describe (the platform is its own archive).
 */

function toMediaRecord(media: StoredSourceMedia): MediaRecord {
  return {
    id: media.id,
    chatId: media.chatId,
    telegramMessageId: Number(media.sourceMessageId),
    kind: media.kind as MediaRecord["kind"],
    fileId: media.fileId,
    fileUniqueId: media.fileUniqueId,
    mimeType: media.mimeType,
    dataBase64: media.frames[0] ?? null,
    frames: media.frames.length > 1 ? media.frames : null,
    visionHint: media.visionHint,
    description: media.description,
    status: media.status as MediaRecord["status"],
    createdAt: media.createdAt.toISOString(),
    describedAt: media.describedAt ? media.describedAt.toISOString() : null,
  };
}

/** The per-row store the describe/transcribe passes read and write. */
export function sourceStoreMediaPort(source: SourceId): MediaStorePort {
  return {
    async getByMessage(chatId, telegramMessageId) {
      const row = await getSourceMediaByMessage(source, chatId, String(telegramMessageId));
      return row ? toMediaRecord(row) : null;
    },
    async markDescribed(id, description) {
      const row = await markSourceMediaDescribed(id, description);
      return row ? toMediaRecord(row) : null;
    },
    async getById(id) {
      const row = await getSourceMediaById(id);
      return row ? toMediaRecord(row) : null;
    },
  };
}

/** The backfill's work list and the gallery's recent rows for one source. */
export function sourceStoreMediaBrowse(source: SourceId) {
  return {
    async listPending(limit: number) {
      const refs = await listPendingSourceMediaRefs(source, limit);
      return refs.map((ref) => ({
        id: ref.id,
        chatId: ref.chatId,
        telegramMessageId: Number(ref.sourceMessageId),
      }));
    },
    async countPending() {
      return countPendingSourceMedia(source);
    },
    async listRecent(limit: number) {
      const rows = await listRecentSourceMedia(source, limit);
      return rows.map(toMediaRecord);
    },
  };
}
