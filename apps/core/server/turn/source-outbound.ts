import "server-only";

import {
  internalDeleteMessageResponseSchema,
  internalSentFileResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
  internalSetTitleResponseSchema,
} from "@assistant-hub/contracts";

import type { SourceId } from "@assistant-hub/contracts";

import { webChatOutbound } from "@/features/web-chat/server/outbound";
import { findMessageRefs } from "@/lib/message-refs";
import { internalRequester, sourceApiConfig } from "@/server/source/internal-client";
import {
  filterMirroredMessageIds,
  markSourceMessageDeleted,
} from "@/server/source-store/repository";

/**
 * Outbound sends to the owning source over its internal API — the calls that
 * need something back (a delivered message id, a mirror-checked refusal) or
 * carry bytes, which the fire-and-forget bus events cannot do: browsing
 * acknowledgements (their id is registered for deletion), voice replies (TTS
 * audio), generated images, and deletes. Plain
 * text replies keep travelling as reply-delivery bus events; the source
 * persists both kinds itself.
 *
 * ONE port, every source: which app answers is resolved from the source id
 * (Phase 4), so the sends below are written once and a new source app needs
 * an entry in the env lookup, not a branch here. An action a platform does
 * not have at all is not a port method with an "unsupported" answer: it is a
 * tool that app's own MCP server simply does not offer (Phase 5).
 */

export interface SourceOutboundPort {
  sendMessage(
    chatId: string,
    opts: {
      text: string;
      replyToMessageId?: number | null;
      threadId?: number | null;
      silent?: boolean;
      /**
       * The assistant whose bot sends (Phase 3: one connection per
       * assistant). Absent → whichever connection runs, the transitional
       * single-bot convention.
       */
      assistantId?: string | null;
      /** Core-resolved whitelist for `#<id>` citation links in `text`. */
      linkableSourceMessageIds?: readonly string[];
    },
  ): Promise<{ messageId: number }>;
  /** Voice bubble with the source's own text fallback; reports what was sent. */
  sendVoice(
    chatId: string,
    opts: {
      audioBase64: string;
      text: string;
      replyToMessageId?: number | null;
      threadId?: number | null;
    },
  ): Promise<{ messageId: number; asVoice: boolean }>;
  /** Generated images; the source mirrors + stores each as pending media. */
  sendPhotos(
    chatId: string,
    opts: { images: string[]; threadId?: number | null },
  ): Promise<{ delivered: { messageId: number; stored: boolean }[] }>;
  /**
   * A file (a browser-run download), sent as playable media where the
   * container allows; the caption is mirrored as the message's content.
   */
  sendFile(
    chatId: string,
    opts: {
      buffer: Buffer;
      filename: string;
      mime?: string | null;
      caption?: string | null;
      threadId?: number | null;
    },
  ): Promise<{ messageId: number }>;
  /** `deleted: false` means the platform refused — cosmetic for every caller. */
  deleteMessage(chatId: string, messageId: number): Promise<{ deleted: boolean }>;
  /**
   * Name a conversation whose source asked to have it named
   * (`chatInfo.titleProvisional`). Absent on sources whose conversations have
   * real names of their own — Telegram's do — which is why it is optional
   * rather than a call that answers "unsupported".
   */
  setChatTitle?(chatId: string, title: string): Promise<{ title: string }>;
}

/**
 * One source's outbound port, or null when this deployment does not run that
 * app. Callers treat null exactly like v1 treated a stopped poller: the send
 * fails audibly and is recorded on the run/fire — never dropped.
 *
 * The web chat resolves to its in-process port since the dissolve (Phase 6).
 * A transport's port is the HTTP client wrapped with the mirror bookkeeping
 * that moved core-side in Phase 7: the `#id` link whitelist rides the send
 * request, and a performed delete lands as a soft delete on the mirror row
 * (deliveries themselves are mirrored off the transport's
 * `message.delivered` events).
 */
export function sourceOutbound(source: SourceId): SourceOutboundPort | null {
  if (source === "chat") return webChatOutbound();
  const port = sourceApiOutbound(source);
  return {
    ...port,
    async sendMessage(chatId, opts) {
      // Chat-wide whitelist: the port does not know the chat's stream shape,
      // and an over-wide list only ever renders a link (the operator plane's
      // unscoped read, the recorded follow-up).
      const linkable = await filterMirroredMessageIds(
        { source, chatId, assistantId: opts.assistantId ?? null, direct: false },
        findMessageRefs(opts.text),
      ).catch(() => []);
      return port.sendMessage(chatId, { ...opts, linkableSourceMessageIds: linkable });
    },
    async deleteMessage(chatId, messageId) {
      const result = await port.deleteMessage(chatId, messageId);
      if (result.deleted) {
        await markSourceMessageDeleted(
          { source, chatId, assistantId: null, direct: false },
          String(messageId),
        ).catch(() => undefined);
      }
      return result;
    },
  };
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * File sends carry up to Telegram's 50MB cap and wait on Telegram's own
 * upload — grammy's client allows 500s, so the port does too.
 */
const FILE_REQUEST_TIMEOUT_MS = 500_000;

export function sourceApiOutbound(source: SourceId): SourceOutboundPort {
  // The requester keeps the source's own verdict: a platform refusal comes
  // back as a 502 carrying the platform's words, and the tool relays them.
  // Config resolves per call from the transport's registration row.
  const request = internalRequester({
    config: () => sourceApiConfig(source),
    label: `${source} internal API`,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  const chatPath = (chatId: string, rest: string) =>
    `/internal/chats/${encodeURIComponent(chatId)}${rest}`;

  return {
    async sendMessage(chatId, opts) {
      const query = opts.assistantId
        ? `?assistantId=${encodeURIComponent(opts.assistantId)}`
        : "";
      const body = internalSentMessageResponseSchema.parse(
        await request(chatPath(chatId, `/messages${query}`), {
          method: "POST",
          body: JSON.stringify({
            text: opts.text,
            replyToSourceMessageId:
              opts.replyToMessageId != null ? String(opts.replyToMessageId) : null,
            threadId: opts.threadId != null ? String(opts.threadId) : null,
            silent: opts.silent ?? false,
            linkableSourceMessageIds: opts.linkableSourceMessageIds ?? [],
          }),
        }),
      );
      return { messageId: Number(body.sourceMessageId) };
    },
    async sendVoice(chatId, opts) {
      const body = internalSentVoiceResponseSchema.parse(
        await request(chatPath(chatId, "/voice"), {
          method: "POST",
          body: JSON.stringify({
            audioBase64: opts.audioBase64,
            text: opts.text,
            replyToSourceMessageId:
              opts.replyToMessageId != null ? String(opts.replyToMessageId) : null,
            threadId: opts.threadId != null ? String(opts.threadId) : null,
          }),
        }),
      );
      return { messageId: Number(body.sourceMessageId), asVoice: body.asVoice };
    },
    async sendPhotos(chatId, opts) {
      const body = internalSentPhotosResponseSchema.parse(
        await request(chatPath(chatId, "/photos"), {
          method: "POST",
          body: JSON.stringify({
            images: opts.images,
            threadId: opts.threadId != null ? String(opts.threadId) : null,
          }),
        }),
      );
      return {
        delivered: body.delivered.map((item) => ({
          messageId: Number(item.sourceMessageId),
          stored: item.stored,
        })),
      };
    },
    async sendFile(chatId, opts) {
      const body = internalSentFileResponseSchema.parse(
        await request(chatPath(chatId, "/files"), {
          method: "POST",
          timeoutMs: FILE_REQUEST_TIMEOUT_MS,
          body: JSON.stringify({
            dataBase64: opts.buffer.toString("base64"),
            filename: opts.filename,
            mime: opts.mime ?? null,
            caption: opts.caption ?? null,
            threadId: opts.threadId != null ? String(opts.threadId) : null,
          }),
        }),
      );
      return { messageId: Number(body.sourceMessageId) };
    },
    async deleteMessage(chatId, messageId) {
      const body = internalDeleteMessageResponseSchema.parse(
        await request(chatPath(chatId, `/messages/${messageId}`), { method: "DELETE" }),
      );
      return { deleted: body.deleted };
    },
    async setChatTitle(chatId, title) {
      const body = internalSetTitleResponseSchema.parse(
        await request(chatPath(chatId, "/title"), {
          method: "PUT",
          body: JSON.stringify({ title }),
        }),
      );
      return { title: body.title };
    },
  };
}
