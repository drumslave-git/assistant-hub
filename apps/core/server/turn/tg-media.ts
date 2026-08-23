import "server-only";

import {
  internalMediaDescribeResponseSchema,
  internalMediaResponseSchema,
  type InternalMedia,
} from "@assistant-hub/contracts";

import type { MediaStorePort } from "@/features/vision/server/service";
import type { MediaRecord } from "@/features/vision/server/repository";
import { requireEnv } from "@/server/env";

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
