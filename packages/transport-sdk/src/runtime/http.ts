import {
  internalEditMenuRequestSchema,
  internalSendFileRequestSchema,
  internalSendMenuRequestSchema,
  internalSendMessageRequestSchema,
  internalSendPhotosRequestSchema,
  internalSendVoiceRequestSchema,
  internalSetTitleRequestSchema,
  type InternalSentPhotosResponse,
} from "@assistant-hub-swarm/contracts";
import { internalTokenGuard, serveMcp } from "@assistant-hub-swarm/service";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";

import { publishDelivered, sendChatMessage, type SendContext } from "./send";
import type { ConnectionStatus, PlatformConnection } from "./types";

/**
 * The HTTP surface every transport serves, built once:
 *
 * - `/health` — liveness plus the connection statuses the dashboard reads
 *   (unauthenticated; it carries no secrets).
 * - `/internal/*` — the sends the core drives: the calls that need a
 *   delivered id back or carry bytes (voice, photos, files, deletes) and the
 *   feedback-menu operations the core-owned flow calls.
 * - `/mcp` — this transport's own MCP server, when it hosts tools.
 *
 * Routes are mounted only for actions the platform actually has. A missing
 * `sendVoice` is not a route that answers 501 — it is a route that does not
 * exist, and the core discovers that the same way it discovers everything
 * else about a transport: by asking.
 *
 * Nothing here reads or writes storage. Every performed send is reported to
 * the core as a `message.delivered` event.
 */

export interface TransportApiDeps {
  send: SendContext;
  internalToken: string;
  statuses: () => ConnectionStatus[];
  /** The MCP server factory, when this transport hosts tools. */
  mcpServer?: (() => McpServer) | null;
  errorText?: (err: unknown) => string;
}

/** The subset of a chat context every internal route resolves the same way. */
interface RouteContext {
  chatId: string;
  assistantId: string | null;
  direct: boolean;
  connection: PlatformConnection;
}

export function createTransportApi(deps: TransportApiDeps): Hono {
  const errorText = deps.errorText ?? ((err: unknown) => (err instanceof Error ? err.message : String(err)));
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, connections: deps.statuses() }));

  const internal = new Hono();
  internal.use("*", internalTokenGuard(deps.internalToken));

  const contextOf = async (c: {
    req: { param: (k: string) => string; query: (k: string) => string | undefined };
  }): Promise<RouteContext> => {
    const chatId = c.req.param("chatId");
    const assistantId = c.req.query("assistantId") ?? null;
    const connection = deps.send.connectionFor(assistantId);
    return {
      chatId,
      assistantId,
      connection,
      direct: await connection.isDirectChat(chatId).catch(() => false),
    };
  };

  const badRequest = (c: { json: (body: unknown, status: 400) => Response }, message: string) =>
    c.json({ error: { message } }, 400);
  const upstream = (c: { json: (body: unknown, status: 502) => Response }, err: unknown) =>
    c.json({ error: { message: errorText(err) } }, 502);

  // ---- Outbound sends -------------------------------------------------------

  internal.post("/chats/:chatId/messages", async (c) => {
    const parsed = internalSendMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "text is required");
    const ctx = await contextOf(c);
    const body = parsed.data;
    try {
      const sent = await sendChatMessage(deps.send, {
        chatId: ctx.chatId,
        assistantId: ctx.assistantId,
        direct: ctx.direct,
        text: body.text,
        replyToSourceMessageId: body.replyToSourceMessageId ?? null,
        threadId: body.threadId ?? null,
        silent: body.silent,
        linkableSourceMessageIds: body.linkableSourceMessageIds ?? [],
      });
      return c.json({ sourceMessageId: sent.sourceMessageId });
    } catch (err) {
      return upstream(c, err);
    }
  });

  // A voice reply is a platform capability; without it the core's TTS path
  // simply never reaches here, because the route is not announced.
  internal.post("/chats/:chatId/voice", async (c) => {
    const parsed = internalSendVoiceRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "audioBase64 and text are required");
    const ctx = await contextOf(c);
    if (!ctx.connection.sendVoice) return badRequest(c, "this platform has no voice messages");
    const body = parsed.data;
    const opts = {
      replyToSourceMessageId: body.replyToSourceMessageId ?? null,
      threadId: body.threadId ?? null,
    };
    let sourceMessageId: string;
    let asVoice = true;
    try {
      const sent = await ctx.connection.sendVoice(
        ctx.chatId,
        { base64: body.audioBase64, filename: "voice.ogg", text: body.text },
        opts,
      );
      sourceMessageId = sent.sourceMessageId;
      asVoice = sent.asVoice;
    } catch {
      // The voice bubble was refused — the answer still arrives, as text.
      try {
        // The text path splits under the cap and reports itself.
        const sent = await sendChatMessage(deps.send, {
          chatId: ctx.chatId,
          assistantId: ctx.assistantId,
          direct: ctx.direct,
          text: body.text,
          ...opts,
        });
        return c.json({ sourceMessageId: sent.sourceMessageId, asVoice: false });
      } catch (err) {
        return upstream(c, err);
      }
    }
    // The report records the spoken text — what history, search, and the
    // next turn's window read.
    await publishDelivered(deps.send, {
      chatId: ctx.chatId,
      assistantId: ctx.assistantId,
      direct: ctx.direct,
      sourceMessageId,
      content: body.text,
      replyToSourceMessageId: opts.replyToSourceMessageId,
      threadId: opts.threadId,
    }).catch(() => undefined);
    return c.json({ sourceMessageId, asVoice });
  });

  internal.post("/chats/:chatId/photos", async (c) => {
    const parsed = internalSendPhotosRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "images are required");
    const ctx = await contextOf(c);
    if (!ctx.connection.sendPhoto) return badRequest(c, "this platform has no photo sends");
    const threadId = parsed.data.threadId ?? null;
    // Best-effort per image: a report failure must not turn a picture the
    // user can see into a failed call, and a send failure skips that image.
    const delivered: InternalSentPhotosResponse["delivered"] = [];
    for (const [index, base64] of parsed.data.images.entries()) {
      let sent: { sourceMessageId: string; mediaId?: string | null };
      try {
        sent = await ctx.connection.sendPhoto(
          ctx.chatId,
          { base64, filename: `image-${index + 1}.png` },
          { threadId },
        );
      } catch (err) {
        console.error(`Failed to deliver a generated image to ${ctx.chatId}:`, errorText(err));
        continue;
      }
      // The report carries the bytes: the core stores the picture as
      // ordinary pending media keyed by the id the platform just minted.
      const stored = await publishDelivered(deps.send, {
        chatId: ctx.chatId,
        assistantId: ctx.assistantId,
        direct: ctx.direct,
        sourceMessageId: sent.sourceMessageId,
        content: "",
        replyToSourceMessageId: null,
        threadId,
        image: sent.mediaId ? { fileId: sent.mediaId, fileUniqueId: null, base64 } : null,
      })
        .then(() => true)
        .catch(() => false);
      delivered.push({ sourceMessageId: sent.sourceMessageId, stored });
    }
    return c.json({ delivered });
  });

  internal.post("/chats/:chatId/files", async (c) => {
    const parsed = internalSendFileRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "dataBase64 and filename are required");
    const ctx = await contextOf(c);
    if (!ctx.connection.sendFile) return badRequest(c, "this platform has no file sends");
    const body = parsed.data;
    const threadId = body.threadId ?? null;
    let sourceMessageId: string;
    try {
      const sent = await ctx.connection.sendFile(
        ctx.chatId,
        { base64: body.dataBase64, filename: body.filename, mime: body.mime ?? null },
        { threadId, caption: body.caption ?? null },
      );
      sourceMessageId = sent.sourceMessageId;
    } catch (err) {
      return upstream(c, err);
    }
    // The caption is the delivered message's readable content.
    await publishDelivered(deps.send, {
      chatId: ctx.chatId,
      assistantId: ctx.assistantId,
      direct: ctx.direct,
      sourceMessageId,
      content: body.caption ?? "",
      replyToSourceMessageId: null,
      threadId,
    }).catch(() => undefined);
    return c.json({ sourceMessageId });
  });

  internal.delete("/chats/:chatId/messages/:messageId", async (c) => {
    const ctx = await contextOf(c);
    // A refused delete (too old, no running connection, no such capability)
    // is cosmetic for every caller — the message simply stays standing.
    if (!ctx.connection.deleteMessage) return c.json({ deleted: false });
    try {
      await ctx.connection.deleteMessage(ctx.chatId, c.req.param("messageId"));
    } catch {
      return c.json({ deleted: false });
    }
    // The soft-delete lands in the core's mirror through its own outbound
    // port; there is no event for it, because the delete is the core's call.
    return c.json({ deleted: true });
  });

  internal.put("/chats/:chatId/title", async (c) => {
    const parsed = internalSetTitleRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "title is required");
    const ctx = await contextOf(c);
    if (!ctx.connection.setChatTitle) return badRequest(c, "this platform names its own chats");
    try {
      return c.json(await ctx.connection.setChatTitle(ctx.chatId, parsed.data.title));
    } catch (err) {
      return upstream(c, err);
    }
  });

  // ---- Feedback menus -------------------------------------------------------
  // The core-owned collection flow posts, edits and removes its option menus
  // through these; presses travel back synchronously through the core API.

  internal.post("/chats/:chatId/menu", async (c) => {
    const parsed = internalSendMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return badRequest(c, "text, keyboard and replyToSourceMessageId are required");
    }
    const ctx = await contextOf(c);
    if (!ctx.connection.sendMenu) return badRequest(c, "this platform has no button menus");
    try {
      const sent = await ctx.connection.sendMenu(ctx.chatId, {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard,
        replyToSourceMessageId: parsed.data.replyToSourceMessageId,
      });
      return c.json({ sourceMessageId: sent.sourceMessageId });
    } catch (err) {
      return upstream(c, err);
    }
  });

  internal.patch("/chats/:chatId/menu/:messageId", async (c) => {
    const parsed = internalEditMenuRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return badRequest(c, "text is required");
    const ctx = await contextOf(c);
    if (!ctx.connection.editMenu) return badRequest(c, "this platform has no button menus");
    try {
      await ctx.connection.editMenu(ctx.chatId, c.req.param("messageId"), {
        text: parsed.data.text,
        keyboard: parsed.data.keyboard ?? null,
      });
      return c.json({ ok: true });
    } catch (err) {
      return upstream(c, err);
    }
  });

  internal.delete("/chats/:chatId/menu/:messageId", async (c) => {
    const ctx = await contextOf(c);
    if (!ctx.connection.deleteMessage) return c.json({ deleted: false });
    try {
      await ctx.connection.deleteMessage(ctx.chatId, c.req.param("messageId"));
      return c.json({ deleted: true });
    } catch {
      // Cosmetic — a menu the platform will not delete simply stays.
      return c.json({ deleted: false });
    }
  });

  app.route("/internal", internal);

  if (deps.mcpServer) {
    const factory = deps.mcpServer;
    // The core reaches this as a managed tool connection, with the same
    // shared secret the internal API takes.
    const mcp = new Hono();
    mcp.use("*", internalTokenGuard(deps.internalToken));
    mcp.all("/", (c) => serveMcp(c, factory));
    app.route("/mcp", mcp);
  }

  return app;
}
