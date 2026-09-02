import "server-only";

import { WEB_CHAT_SOURCE } from "@assistant-hub-swarm/contracts";

import type { MediaRecord } from "@/features/vision/server/repository";
import type { MediaStorePort } from "@/features/vision/server/service";

import {
  countPendingMedia,
  getMediaById,
  getMediaByMessage,
  listPendingMediaRefs,
  listRecentMedia,
  markDescribed,
  type StoredWebMedia,
} from "./media-repository";

/**
 * The web chat's media, as the vision pipeline's {@link MediaStorePort} —
 * what used to be the chat app's `/internal/media/*` API, as direct store
 * reads since the dissolve. The describe/transcribe models read a pending
 * row's bytes here and write the text back; the bytes stay after describing
 * (a web thread is the only archive its images have — see
 * `media-repository.ts`).
 */

function toMediaRecord(media: StoredWebMedia): MediaRecord {
  return {
    id: media.id,
    source: WEB_CHAT_SOURCE,
    chatId: media.threadId,
    sourceMessageId: String(media.messageId),
    kind: media.kind as MediaRecord["kind"],
    // File ids are a Telegram concept; a web upload has none.
    fileId: "",
    fileUniqueId: null,
    mimeType: media.mimeType,
    dataBase64: media.frames[0] ?? null,
    frames: media.frames.length > 1 ? media.frames : null,
    // A browser upload carries no describe hint of its own.
    visionHint: null,
    description: media.description,
    status: media.status as MediaRecord["status"],
    createdAt: media.createdAt.toISOString(),
    describedAt: media.describedAt ? media.describedAt.toISOString() : null,
  };
}

/** The per-row store the describe/transcribe passes read and write. */
export function webChatMediaStore(): MediaStorePort {
  return {
    async getByMessage(chatId, sourceMessageId) {
      const row = await getMediaByMessage(chatId, Number(sourceMessageId));
      return row ? toMediaRecord(row) : null;
    },
    async markDescribed(id, description) {
      // The in-process contract: null when a concurrent pass already won.
      const row = await markDescribed(id, description);
      return row ? toMediaRecord(row) : null;
    },
    async getById(id) {
      const row = await getMediaById(id);
      return row ? toMediaRecord(row) : null;
    },
  };
}

/** The backfill's work list and the gallery's recent rows (browse surface). */
export const webChatMediaBrowse = {
  async listPending(limit: number) {
    const refs = await listPendingMediaRefs(limit);
    return refs.map((ref) => ({
      id: ref.id,
      chatId: ref.threadId,
      sourceMessageId: String(ref.messageId),
    }));
  },
  async countPending() {
    return countPendingMedia();
  },
  async listRecent(limit: number) {
    const rows = await listRecentMedia(limit);
    return rows.map(toMediaRecord);
  },
};
