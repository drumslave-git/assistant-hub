import {
  internalMediaDescribeRequestSchema,
  type InternalMedia,
} from "@assistant-hub/contracts";
import { Hono } from "hono";

import type { TgDb } from "./db";
import type { BotManager } from "./bot-manager";
import { getMediaByMessage, getMediaById, markDescribed } from "./media/store";
import type { StoredMedia } from "./media/types";

/**
 * This app's HTTP surface (Hono — user decision, 2026-08-23). Two zones:
 *
 * - `/health` — liveness/readiness for compose and the dashboard.
 * - `/internal/*` — the API only the core reaches (through its proxy /
 *   server code), authenticated by the shared `INTERNAL_API_TOKEN` header
 *   (user decision, 2026-08-23: shared secret, not network topology —
 *   dev runs everything on localhost). The operator listing/CRUD API and
 *   the media/search/summaries endpoints land here slice by slice.
 */

export function createApi(input: {
  db: TgDb;
  manager: Pick<BotManager, "statuses">;
  internalToken: string;
}): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    // Probe the real thing, not configuration: the database answers, and the
    // poller states are reported as they are.
    try {
      await input.db.execute("select 1");
    } catch {
      return c.json({ ok: false, error: "database unreachable" }, 503);
    }
    return c.json({ ok: true, connections: input.manager.statuses() });
  });

  const internal = new Hono();
  internal.use("*", async (c, next) => {
    if (c.req.header("x-internal-token") !== input.internalToken) {
      return c.json({ error: { message: "unauthorized" } }, 401);
    }
    await next();
  });
  // First real internal endpoint: the connection statuses the dashboard's
  // bot card shows (reached via the core proxy).
  internal.get("/connections", (c) => c.json({ connections: input.manager.statuses() }));

  // The media surface (slice B): the core's vision/voice features read a
  // pending row's bytes here, run the describe/transcribe model, and write
  // the text back — this app then drops the bytes.
  internal.get("/chats/:chatId/messages/:messageId/media", async (c) => {
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    const media = await getMediaByMessage(input.db, chatId, messageId);
    return c.json({ media: media ? toInternalMedia(media) : null });
  });

  internal.get("/media/:id", async (c) => {
    const media = await getMediaById(input.db, c.req.param("id"));
    return c.json({ media: media ? toInternalMedia(media) : null });
  });

  internal.put("/media/:id/description", async (c) => {
    const parsed = internalMediaDescribeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "description is required" } }, 400);
    }
    const id = c.req.param("id");
    const updated = await markDescribed(input.db, id, parsed.data.description);
    if (updated) {
      return c.json({ updated: true, media: toInternalMedia(updated) });
    }
    // Not pending any more: a concurrent pass won — serve the stored winner
    // (the in-process `markDescribed` contract), or 404 for an unknown id.
    const current = await getMediaById(input.db, id);
    if (!current) return c.json({ error: { message: "media not found" } }, 404);
    return c.json({ updated: false, media: toInternalMedia(current) });
  });

  app.route("/internal", internal);

  return app;
}

function toInternalMedia(media: StoredMedia): InternalMedia {
  return {
    id: media.id,
    chatId: media.chatId,
    sourceMessageId: String(media.telegramMessageId),
    kind: media.kind,
    status: media.status as InternalMedia["status"],
    description: media.description,
    visionHint: media.visionHint,
    mimeType: media.mimeType,
    frames: media.frames,
    createdAt: media.createdAt.toISOString(),
    describedAt: media.describedAt ? media.describedAt.toISOString() : null,
  };
}
