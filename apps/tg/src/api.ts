import {
  internalMediaDescribeRequestSchema,
  internalReactionRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  type InternalMedia,
  type InternalReactionResponse,
  type InternalSentPhotosResponse,
} from "@assistant-hub/contracts";
import { Hono } from "hono";

import type { TgDb } from "./db";
import type { BotManager } from "./bot-manager";
import { ingestGeneratedImage } from "./media/ingest";
import { getMediaByMessage, getMediaById, markDescribed } from "./media/store";
import type { StoredMedia } from "./media/types";
import type { TgOutbound } from "./outbound";
import {
  appendMessage,
  filterMirroredMessageIds,
  getMessageByTelegramId,
  markMessageDeleted,
  recordBotReaction,
} from "./store";
import { findMessageRefs } from "./telegram";

/**
 * This app's HTTP surface (Hono — user decision, 2026-08-23). Two zones:
 *
 * - `/health` — liveness/readiness for compose and the dashboard.
 * - `/internal/*` — the API only the core reaches (through its proxy /
 *   server code), authenticated by the shared `INTERNAL_API_TOKEN` header
 *   (user decision, 2026-08-23: shared secret, not network topology —
 *   dev runs everything on localhost). The operator listing/CRUD API and
 *   the media/search/summaries endpoints land here slice by slice.
 *
 * The outbound sends (slice D) are the calls that need something back from
 * this app (a delivered id, a mirror-checked refusal) or carry bytes —
 * voice replies, generated images, acknowledgements, deletes, reactions.
 * Plain text replies keep travelling as reply-delivery bus events; these
 * endpoints mirror what they deliver the same way the delivery consumer
 * does.
 */

export function createApi(input: {
  db: TgDb;
  manager: Pick<BotManager, "statuses" | "senderFor">;
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

  // ---- Outbound sends (slice D) -------------------------------------------
  // The connection to send through: Phase 2 runs a single connection, so an
  // absent `assistantId` query resolves to "whichever runs" (the same
  // convention as the delivery consumer); Phase 3 threads assistants
  // through every caller. A send with no running connection is a 502 the
  // core relays — never a silent drop.

  const senderOf = (c: { req: { query: (k: string) => string | undefined } }): TgOutbound =>
    input.manager.senderFor(c.req.query("assistantId") ?? null);

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "text is required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    const replyToMessageId =
      body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null;
    const linkableMessageIds = await filterMirroredMessageIds(
      input.db,
      chatId,
      findMessageRefs(body.text),
    ).catch(() => []);
    let sent: { messageId: number };
    try {
      sent = await senderOf(c).sendMessage(chatId, body.text, {
        replyToMessageId,
        threadId: body.threadId != null ? Number(body.threadId) : null,
        silent: body.silent,
        linkableMessageIds,
      });
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
    await appendMessage(input.db, {
      chatId,
      telegramMessageId: sent.messageId,
      role: "assistant",
      userId: null,
      content: body.text,
      replyToMessageId,
      sentAt: new Date(),
      processed: true,
    }).catch(() => null);
    return c.json({ sourceMessageId: String(sent.messageId) });
  });

  internal.post("/chats/:chatId/voice", async (c) => {
    const parsed = internalSendVoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "audioBase64 and text are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    const replyToMessageId =
      body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null;
    const threadId = body.threadId != null ? Number(body.threadId) : null;
    const sender = senderOf(c);
    let sent: { messageId: number };
    let asVoice = true;
    try {
      sent = await sender.sendVoice(
        chatId,
        { base64: body.audioBase64, filename: "voice.ogg" },
        { replyToMessageId, threadId },
      );
    } catch {
      // The voice bubble was refused — the answer still arrives, as text
      // (v1's degradation, now owned by the source per the contract).
      try {
        sent = await sender.sendMessage(chatId, body.text, { replyToMessageId, threadId });
        asVoice = false;
      } catch (err) {
        return c.json({ error: { message: errorText(err) } }, 502);
      }
    }
    // The mirror records the spoken text — what history, search, and the
    // next turn's window read (v1: the text form is what is mirrored).
    await appendMessage(input.db, {
      chatId,
      telegramMessageId: sent.messageId,
      role: "assistant",
      userId: null,
      content: body.text,
      replyToMessageId,
      sentAt: new Date(),
      processed: true,
    }).catch(() => null);
    return c.json({ sourceMessageId: String(sent.messageId), asVoice });
  });

  internal.post("/chats/:chatId/photos", async (c) => {
    const parsed = internalSendPhotosRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "images are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const threadId = parsed.data.threadId != null ? Number(parsed.data.threadId) : null;
    const sender = senderOf(c);
    // Best-effort per image, like v1's deliverGeneratedImages: a mirroring
    // failure must not turn a picture the user can see into a failed call,
    // and a send failure skips that image's rows entirely.
    const delivered: InternalSentPhotosResponse["delivered"] = [];
    for (const [index, base64] of parsed.data.images.entries()) {
      let sent: { messageId: number; fileId: string; fileUniqueId: string | null };
      try {
        sent = await sender.sendPhoto(
          chatId,
          { base64, filename: `image-${index + 1}.png` },
          { threadId },
        );
      } catch (err) {
        console.error(`Failed to deliver a generated image to ${chatId}:`, errorText(err));
        continue;
      }
      // The same pair of rows an incoming media message produces: a
      // media-only assistant mirror row (the picture IS the message) and a
      // pending media row keyed by the file id Telegram just minted.
      const mirrored = await appendMessage(input.db, {
        chatId,
        telegramMessageId: sent.messageId,
        role: "assistant",
        userId: null,
        content: "",
        replyToMessageId: null,
        sentAt: new Date(),
        processed: true,
      }).catch(() => null);
      const stored =
        mirrored != null && sent.fileId
          ? await ingestGeneratedImage({
              db: input.db,
              chatId,
              telegramMessageId: sent.messageId,
              fileId: sent.fileId,
              fileUniqueId: sent.fileUniqueId,
              base64,
            })
          : null;
      delivered.push({ sourceMessageId: String(sent.messageId), stored: stored != null });
    }
    return c.json({ delivered });
  });

  internal.delete("/chats/:chatId/messages/:messageId", async (c) => {
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    // A refused delete (older than 48h, no running connection) is cosmetic
    // for every caller — the message simply stays standing.
    try {
      await senderOf(c).deleteMessage(chatId, messageId);
    } catch {
      return c.json({ deleted: false });
    }
    await markMessageDeleted(input.db, chatId, messageId).catch(() => undefined);
    return c.json({ deleted: true });
  });

  internal.post("/chats/:chatId/messages/:messageId/reaction", async (c) => {
    const parsed = internalReactionRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "emoji (or null) is required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    // The mirror gates the platform call (v1 tool order): an id the model
    // guessed, or the bot's own message, is refused without touching
    // Telegram — the core's tool words these refusals for the model.
    const target = await getMessageByTelegramId(input.db, chatId, messageId);
    if (!target) {
      return c.json({ status: "not_found", recorded: false } satisfies InternalReactionResponse);
    }
    if (target.role === "assistant") {
      return c.json({ status: "own_message", recorded: false } satisfies InternalReactionResponse);
    }
    try {
      await senderOf(c).setReaction(chatId, messageId, parsed.data.emoji, {
        big: parsed.data.big,
      });
    } catch (err) {
      // Telegram refused for a reason only it knows (chat-restricted emoji,
      // message too old) — relayed verbatim, so the tool can tell the model
      // not to claim it reacted.
      return c.json({ error: { message: errorText(err) } }, 502);
    }
    // Mirror the reaction so the bot remembers reacting; the reaction IS on
    // the message, so a failed write degrades to `recorded: false` (v1).
    let recorded = true;
    try {
      await recordBotReaction(input.db, { chatId, telegramMessageId: messageId, emoji: parsed.data.emoji });
    } catch {
      recorded = false;
    }
    return c.json({ status: "ok", recorded } satisfies InternalReactionResponse);
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
