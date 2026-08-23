import "server-only";

import {
  internalMediaDescribeResponseSchema,
  internalMediaResponseSchema,
  internalPendingMediaResponseSchema,
  internalRecentMediaResponseSchema,
  type InternalMedia,
} from "@assistant-hub/contracts";

import type { MediaStorePort } from "@/features/vision/server/service";
import type { MediaRecord } from "@/features/vision/server/repository";
import { getEnv, requireEnv } from "@/server/env";

/**
 * The tg store's media, reached over its internal API (contract schemas in
 * `@assistant-hub/contracts`) — the queue-consumer's {@link MediaStorePort}.
 * The core's describe/transcribe features read a pending row's bytes here
 * and write the text back; the tg app drops the bytes (describe-then-drop,
 * storage owned by the app — user decision, 2026-08-22).
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

export function tgApiMediaStore(config?: { baseUrl?: string; token?: string }): MediaStorePort {
  const baseUrl = (config?.baseUrl ?? requireEnv("TG_API_URL")).replace(/\/$/, "");
  const token = config?.token ?? requireEnv("INTERNAL_API_TOKEN");

  const request = async (path: string, init?: RequestInit): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`tg internal API ${path} answered ${res.status}`);
    }
    return res.json();
  };

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
 * What the vision feature needs of the source's media beyond the per-row
 * store: the backfill's work list and the dashboard gallery's recent rows.
 */
export interface SourceMediaBrowse {
  store: MediaStorePort;
  listPending(limit: number): Promise<{ id: string; chatId: string; telegramMessageId: number }[]>;
  countPending(): Promise<number>;
  listRecent(limit: number): Promise<MediaRecord[]>;
}

/** The tg-API-backed browse surface, or null when the source API is unset. */
export function resolveSourceMediaBrowse(): SourceMediaBrowse | null {
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  const baseUrl = env.TG_API_URL.replace(/\/$/, "");
  const token = env.INTERNAL_API_TOKEN;
  const request = async (path: string): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { "x-internal-token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tg internal API ${path} answered ${res.status}`);
    return res.json();
  };
  return {
    store: tgApiMediaStore(),
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
