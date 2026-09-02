import {
  internalEditMenuRequestSchema,
  internalSendFileRequestSchema,
  internalSendMenuRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  type InternalSentPhotosResponse,
} from "@assistant-hub-swarm/contracts";
import { internalTokenGuard, serveMcp } from "@assistant-hub-swarm/service";
import { Hono } from "hono";

import type { AssistantConnection } from "./connections";
import type { BotManager } from "./bot-manager";
import { createTgMcpServer } from "./mcp";
import type { TgOutbound } from "./outbound";
import { publishDelivered, sendChatMessage } from "./send";
import type { UpdatePublisher } from "./updates";

/**
 * This app's HTTP surface, slimmed to what a stateless transport serves
 * (redesign Phase 7):
 *
 * - `/health` — liveness plus the poller statuses the dashboard's status
 *   surfaces read (unauthenticated; it carries no secrets).
 * - `/internal/*` — the sends the core drives (the calls that need a
 *   delivered id back or carry bytes: voice, photos, files, deletes) and
 *   the feedback-menu operations the core-owned flow calls.
 * - `/mcp` — this app's own MCP server (delivery + reaction tools).
 *
 * Every performed send is reported to the core as a `message.delivered`
 * event; nothing here reads or writes any storage at all.
 */

export function createApi(input: {
  manager: Pick<BotManager, "statuses" | "senderFor">;
  internalToken: string;
  updates: UpdatePublisher;
  running: () => AssistantConnection[];
}): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    return c.json({ ok: true, connections: input.manager.statuses() });
  });

  const internal = new Hono();
  internal.use("*", internalTokenGuard(input.internalToken));

  // ---- Outbound sends -------------------------------------------------------
  // The calls that need something back (a delivered id, a mirror-checked
  // refusal) or carry bytes. Every one reports a `message.delivered` event;
  // plain text replies keep travelling as reply-delivery bus events.

  const assistantIdOf = (c: { req: { query: (k: string) => string | undefined } }): string | null =>
    c.req.query("assistantId") ?? null;

  const senderOf = (c: { req: { query: (k: string) => string | undefined } }): TgOutbound =>
    input.manager.senderFor(assistantIdOf(c));

  const sendDeps = (c: { req: { query: (k: string) => string | undefined } }) => ({
    sender: senderOf(c),
    publisher: input.updates,
    running: input.running,
  });

  const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "text is required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    let sent;
    try {
      sent = await sendChatMessage(sendDeps(c), {
        chatId,
        assistantId: assistantIdOf(c),
        text: body.text,
        replyToMessageId:
          body.replyToSourceMessageId != null ? Number(body.replyToSourceMessageId) : null,
        threadId: body.threadId != null ? Number(body.threadId) : null,
        silent: body.silent,
        linkableMessageIds: (body.linkableSourceMessageIds ?? [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id)),
      });
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
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
      // The voice bubble was refused — the answer still arrives, as text.
      try {
        // The text path splits under the cap and reports itself.
        sent = await sendChatMessage(sendDeps(c), {
          chatId,
          assistantId: assistantIdOf(c),
          text: body.text,
          replyToMessageId,
          threadId,
        });
        asVoice = false;
      } catch (err) {
        return c.json({ error: { message: errorText(err) } }, 502);
      }
    }
    // The report records the spoken text — what history, search, and the
    // next turn's window read. (The text fallback reported itself.)
    if (asVoice) await publishDelivered(
      { publisher: input.updates, running: input.running },
      {
        chatId,
        assistantId: assistantIdOf(c),
        messageId: sent.messageId,
        content: body.text,
        replyToMessageId,
        threadId,
      },
    ).catch(() => undefined);
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
    // Best-effort per image: a report failure must not turn a picture the
    // user can see into a failed call, and a send failure skips that image.
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
      // The report carries the bytes: the core stores the picture as
      // ordinary pending media keyed by the file id Telegram just minted.
      const reported = await publishDelivered(
        { publisher: input.updates, running: input.running },
        {
          chatId,
          assistantId: assistantIdOf(c),
          messageId: sent.messageId,
          content: "",
          replyToMessageId: null,
          threadId,
          image: sent.fileId
            ? { fileId: sent.fileId, fileUniqueId: sent.fileUniqueId, base64 }
            : null,
        },
      )
        .then(() => true)
        .catch(() => false);
      delivered.push({ sourceMessageId: String(sent.messageId), stored: reported });
    }
    return c.json({ delivered });
  });

  internal.post("/chats/:chatId/files", async (c) => {
    const parsed = internalSendFileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "dataBase64 and filename are required" } }, 400);
    }
    const chatId = c.req.param("chatId");
    const body = parsed.data;
    let sent: { messageId: number };
    try {
      sent = await senderOf(c).sendFile(
        chatId,
        { base64: body.dataBase64, filename: body.filename, mime: body.mime ?? null },
        {
          threadId: body.threadId != null ? Number(body.threadId) : null,
          caption: body.caption ?? null,
        },
      );
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
    // The caption is the delivered message's readable content.
    await publishDelivered(
      { publisher: input.updates, running: input.running },
      {
        chatId,
        assistantId: assistantIdOf(c),
        messageId: sent.messageId,
        content: body.caption ?? "",
        replyToMessageId: null,
        threadId: body.threadId != null ? Number(body.threadId) : null,
      },
    ).catch(() => undefined);
    return c.json({ sourceMessageId: String(sent.messageId) });
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
    // The soft-delete lands in the core's mirror via the ingest; there is no
    // dedicated event — the delete is the core's own call, and its outbound
    // port records it (see `source-outbound.ts`).
    return c.json({ deleted: true });
  });

  // ---- Feedback menus -------------------------------------------------------
  // The core-owned collection flow posts, edits and removes its option menus
  // through these; presses travel back synchronously (`core-client.ts`).

  internal.post("/chats/:chatId/menu", async (c) => {
    const parsed = internalSendMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: { message: "text, keyboard and replyToSourceMessageId are required" } }, 400);
    }
    try {
      const sent = await senderOf(c).sendMenu(c.req.param("chatId"), {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard,
        replyToMessageId: Number(parsed.data.replyToSourceMessageId),
      });
      return c.json({ sourceMessageId: String(sent.messageId) });
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
  });

  internal.patch("/chats/:chatId/menu/:messageId", async (c) => {
    const parsed = internalEditMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: { message: "text is required" } }, 400);
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    try {
      await senderOf(c).editMenu(c.req.param("chatId"), messageId, {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard,
      });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: { message: errorText(err) } }, 502);
    }
  });

  internal.delete("/chats/:chatId/menu/:messageId", async (c) => {
    const messageId = Number(c.req.param("messageId"));
    if (!Number.isFinite(messageId)) {
      return c.json({ error: { message: "messageId must be a number" } }, 400);
    }
    try {
      await senderOf(c).deleteMessage(c.req.param("chatId"), messageId);
      return c.json({ deleted: true });
    } catch {
      // Cosmetic — a menu Telegram will not delete simply stays.
      return c.json({ deleted: false });
    }
  });

  // This app's own MCP server (Phase 5): the core reaches it as a managed
  // tool connection, with the same shared secret the internal API takes.
  const mcp = new Hono();
  mcp.use("*", internalTokenGuard(input.internalToken));
  mcp.all("/", (c) =>
    serveMcp(c, () =>
      createTgMcpServer({
        manager: input.manager,
        updates: input.updates,
        running: input.running,
      }),
    ),
  );

  app.route("/internal", internal);
  app.route("/mcp", mcp);

  return app;
}
