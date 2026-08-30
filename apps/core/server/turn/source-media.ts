import "server-only";

import {
  internalMediaDescribeResponseSchema,
  internalMediaResponseSchema,
  internalPendingMediaResponseSchema,
  internalRecentMediaResponseSchema,
  type InternalMedia,
} from "@assistant-hub/contracts";

import { SOURCE_IDS, type SourceId } from "@assistant-hub/contracts";

import type { MediaStorePort } from "@/features/vision/server/service";
import type { MediaRecord } from "@/features/vision/server/repository";
import { webChatMediaBrowse, webChatMediaStore } from "@/features/web-chat/server/media-store";
import { internalRequester, sourceApiConfig } from "@/server/source/internal-client";

/**
 * A source's media, reached over its internal API (contract schemas in
 * `@assistant-hub/contracts`) — the queue-consumer's {@link MediaStorePort}.
 * The core's describe/transcribe features read a pending row's bytes here
 * and write the text back; what the source then does with the bytes is its
 * own business (tg drops them, a web thread keeps them — it is the only
 * archive its images have).
 *
 * Which app answers is resolved from the source id, so the calls below are
 * written once for every source.
 */

const REQUEST_TIMEOUT_MS = 30_000;

function toMediaRecord(media: InternalMedia): MediaRecord {
  return {
    id: media.id,
    chatId: media.chatId,
    telegramMessageId: Number(media.sourceMessageId),
    kind: media.kind as MediaRecord["kind"],
    // File ids never cross the contract — downloads are the source's job.
    fileId: "",
    fileUniqueId: null,
    mimeType: media.mimeType,
    dataBase64: media.frames[0] ?? null,
    frames: media.frames.length > 1 ? media.frames : null,
    visionHint: media.visionHint,
    description: media.description,
    status: media.status,
    createdAt: media.createdAt,
    describedAt: media.describedAt,
  };
}

/**
 * One source's media store, or null when this deployment does not run it.
 * The web chat resolves in-process since the dissolve (Phase 6).
 */
export function sourceMediaStore(source: SourceId): MediaStorePort | null {
  if (source === "chat") return webChatMediaStore();
  const config = sourceApiConfig(source);
  if (!config) return null;
  const request = internalRequester({
    ...config,
    label: `${source} internal API`,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  return {
    async getByMessage(chatId, telegramMessageId) {
      const body = internalMediaResponseSchema.parse(
        await request(
          `/internal/chats/${encodeURIComponent(chatId)}/messages/${telegramMessageId}/media`,
        ),
      );
      return body.media ? toMediaRecord(body.media) : null;
    },
    async markDescribed(id, description) {
      const body = internalMediaDescribeResponseSchema.parse(
        await request(`/internal/media/${encodeURIComponent(id)}/description`, {
          method: "PUT",
          body: JSON.stringify({ description }),
        }),
      );
      // The in-process contract: null when a concurrent pass already won.
      return body.updated && body.media ? toMediaRecord(body.media) : null;
    },
    async getById(id) {
      const body = internalMediaResponseSchema.parse(
        await request(`/internal/media/${encodeURIComponent(id)}`),
      );
      return body.media ? toMediaRecord(body.media) : null;
    },
  };
}

/**
 * What the vision feature needs of a source's media beyond the per-row
 * store: the backfill's work list and the dashboard gallery's recent rows.
 * Every source serves it, so the backfill and the gallery fan out rather
 * than knowing which app has pictures.
 */
export interface SourceMediaBrowse {
  /** Which app this surface reads — rows are tagged with it. */
  source: SourceId;
  store: MediaStorePort;
  listPending(limit: number): Promise<{ id: string; chatId: string; telegramMessageId: number }[]>;
  countPending(): Promise<number>;
  listRecent(limit: number): Promise<MediaRecord[]>;
}

/** One source's browse surface, or null when this deployment does not run it. */
export function sourceMediaBrowse(source: SourceId): SourceMediaBrowse | null {
  if (source === "chat") {
    return { source, store: webChatMediaStore(), ...webChatMediaBrowse };
  }
  const config = sourceApiConfig(source);
  if (!config) return null;
  const store = sourceMediaStore(source);
  if (!store) return null;
  const request = internalRequester({
    ...config,
    label: `${source} internal API`,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return {
    source,
    store,
    async listPending(limit) {
      const body = internalPendingMediaResponseSchema.parse(
        await request(`/internal/media/pending?limit=${limit}`),
      );
      return body.media.map((row) => ({
        id: row.id,
        chatId: row.chatId,
        telegramMessageId: Number(row.sourceMessageId),
      }));
    },
    async countPending() {
      const body = internalPendingMediaResponseSchema.parse(
        await request(`/internal/media/pending?limit=0`),
      );
      return body.total;
    },
    async listRecent(limit) {
      const body = internalRecentMediaResponseSchema.parse(
        await request(`/internal/media/recent?limit=${limit}`),
      );
      return body.media.map(toMediaRecord);
    },
  };
}

/**
 * Every source this deployment runs, in registry order. The backfill and the
 * dashboard gallery work across all of them: pictures arrive wherever people
 * are, and neither surface should have to know which app that was.
 */
export function mediaSources(): SourceMediaBrowse[] {
  return SOURCE_IDS.map((source) => sourceMediaBrowse(source)).filter(
    (browse): browse is SourceMediaBrowse => browse !== null,
  );
}
