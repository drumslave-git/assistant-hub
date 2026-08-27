import "server-only";

import {
  internalDeleteMessageResponseSchema,
  internalReactionResponseSchema,
  internalSentFileResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
} from "@assistant-hub/contracts";

import type { SourceId } from "@assistant-hub/contracts";

import { internalRequester, sourceApiConfig } from "@/server/source/internal-client";

/**
 * Outbound sends to the owning source over its internal API — the calls that
 * need something back (a delivered message id, a mirror-checked refusal) or
 * carry bytes, which the fire-and-forget bus events cannot do: browsing
 * acknowledgements (their id is registered for deletion), voice replies (TTS
 * audio), generated images, deletes, and the assistant's reactions. Plain
 * text replies keep travelling as reply-delivery bus events; the source
 * persists both kinds itself.
 *
 * ONE port, every source: which app answers is resolved from the source id
 * (Phase 4), so the sends below are written once and a new source app needs
 * an entry in the env lookup, not a branch here. Where a platform has no
 * analogue for a call — a web thread cannot be reacted to — the source
 * answers `unsupported` and the tool reports that, rather than the core
 * deciding for it.
 */

/**
 * Refusal states a source can answer for a reaction: the mirror's checks, and
 * `unsupported` for a platform that has no reactions at all.
 */
export type SourceReactionStatus = "ok" | "not_found" | "own_message" | "unsupported";

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
   * Set (null: clear) the assistant's reaction badge. Refusals the source's
   * mirror can decide come back as a status; a platform refusal (an emoji
   * this chat does not allow, a message too old) throws with the platform's
   * message for the tool to relay.
   */
  setReaction(
    chatId: string,
    messageId: number,
    emoji: string | null,
    opts?: { big?: boolean },
  ): Promise<{ status: SourceReactionStatus; recorded: boolean }>;
}

/**
 * One source's outbound port, or null when this deployment does not run that
 * app. Callers treat null exactly like v1 treated a stopped poller: the send
 * fails audibly and is recorded on the run/fire — never dropped.
 */
export function sourceOutbound(source: SourceId): SourceOutboundPort | null {
  const config = sourceApiConfig(source);
  if (!config) return null;
  return sourceApiOutbound(source, config);
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * File sends carry up to Telegram's 50MB cap and wait on Telegram's own
 * upload — grammy's client allows 500s, so the port does too.
 */
const FILE_REQUEST_TIMEOUT_MS = 500_000;

export function sourceApiOutbound(
  source: SourceId,
  config: { baseUrl: string; token: string },
): SourceOutboundPort {
  // The requester keeps the source's own verdict: a platform refusal comes
  // back as a 502 carrying the platform's words, and the tool relays them.
  const request = internalRequester({
    ...config,
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
    async setReaction(chatId, messageId, emoji, opts) {
      const body = internalReactionResponseSchema.parse(
        await request(chatPath(chatId, `/messages/${messageId}/reaction`), {
          method: "POST",
          body: JSON.stringify({ emoji, big: opts?.big ?? false }),
        }),
      );
      return { status: body.status, recorded: body.recorded };
    },
  };
}
