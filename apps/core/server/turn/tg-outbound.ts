import "server-only";

import {
  internalDeleteMessageResponseSchema,
  internalReactionResponseSchema,
  internalSentFileResponseSchema,
  internalSentMessageResponseSchema,
  internalSentPhotosResponseSchema,
  internalSentVoiceResponseSchema,
} from "@assistant-hub/contracts";

import { getEnv, requireEnv } from "@/server/env";

/**
 * Outbound sends to the owning source over its internal API (slice D) —
 * the calls that need something back (a delivered message id, a
 * mirror-checked refusal) or carry bytes, which the fire-and-forget bus
 * events cannot do: browsing acknowledgements (their id is registered for
 * deletion), voice replies (TTS audio), generated images, deletes, and the
 * assistant's reactions. Plain text replies keep travelling as
 * reply-delivery bus events; the source mirrors both kinds itself.
 */

/** Refusal states the source's mirror check can answer for a reaction. */
export type SourceReactionStatus = "ok" | "not_found" | "own_message";

export interface SourceOutboundPort {
  sendMessage(
    chatId: string,
    opts: {
      text: string;
      replyToMessageId?: number | null;
      threadId?: number | null;
      silent?: boolean;
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
 * The tg outbound port from env, or null when the source API is not
 * configured. Callers treat null exactly like v1 treated a stopped poller:
 * the send fails audibly and is recorded on the run/fire — never dropped.
 */
export function resolveSourceOutbound(): SourceOutboundPort | null {
  const env = getEnv();
  if (!env.TG_API_URL || !env.INTERNAL_API_TOKEN) return null;
  return tgApiOutbound();
}

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * File sends carry up to Telegram's 50MB cap and wait on Telegram's own
 * upload — grammy's client allows 500s, so the port does too.
 */
const FILE_REQUEST_TIMEOUT_MS = 500_000;

export function tgApiOutbound(config?: { baseUrl?: string; token?: string }): SourceOutboundPort {
  const baseUrl = (config?.baseUrl ?? requireEnv("TG_API_URL")).replace(/\/$/, "");
  const token = config?.token ?? requireEnv("INTERNAL_API_TOKEN");

  const request = async (
    path: string,
    init?: RequestInit & { timeoutMs?: number },
  ): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "x-internal-token": token,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      // The source relays platform refusals as a 502 with the platform's
      // words — surface those; anything else names the failing call.
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(body?.error?.message ?? `tg internal API ${path} answered ${res.status}`);
    }
    return res.json();
  };

  const chatPath = (chatId: string, rest: string) =>
    `/internal/chats/${encodeURIComponent(chatId)}${rest}`;

  return {
    async sendMessage(chatId, opts) {
      const body = internalSentMessageResponseSchema.parse(
        await request(chatPath(chatId, "/messages"), {
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
