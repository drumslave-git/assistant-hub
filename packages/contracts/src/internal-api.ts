import { z } from "zod";

/**
 * The source apps' INTERNAL HTTP API — what the core's features call to read
 * and write conversation-derived content the apps own (user decision,
 * 2026-08-22: core provides tools and features, apps provide storage).
 * Authenticated by the shared `x-internal-token` header; reached only from
 * the core's server code, never a browser.
 *
 * First surface (Phase 2 slice B): media. The core's vision/voice features
 * read a pending row's bytes, run the describe/transcribe model, and write
 * the description back — the app then drops the bytes (describe-then-drop
 * lifecycle). Both sides parse these schemas, which is what keeps them in
 * lockstep without importing each other's code.
 */

/**
 * One media row as served over the internal API. `frames` carries the
 * pending payload as base64 — the ordered frame sequence for a video/GIF,
 * a single frame for a still image, the raw audio blob for a voice message —
 * and is empty once described/unavailable (the bytes are gone).
 */
export const internalMediaSchema = z.object({
  id: z.string().min(1),
  /** Source-local chat id + message id the row is attached to. */
  chatId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(["pending", "described", "unavailable"]),
  description: z.string().nullable(),
  /** Describe hint stored at ingestion (sticker emoji, frame-sequence note). */
  visionHint: z.string().nullable(),
  mimeType: z.string().nullable(),
  frames: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  describedAt: z.string().nullable(),
});

export type InternalMedia = z.infer<typeof internalMediaSchema>;

/** GET /internal/chats/:chatId/messages/:messageId/media */
export const internalMediaResponseSchema = z.object({
  media: internalMediaSchema.nullable(),
});

/** PUT /internal/media/:id/description — store the produced text, drop bytes. */
export const internalMediaDescribeRequestSchema = z.object({
  description: z.string().min(1),
});

/**
 * PUT response. `updated: false` means the row was no longer pending (a
 * concurrent pass won) — `media` then carries the stored winner, mirroring
 * the in-process `markDescribed` contract.
 */
export const internalMediaDescribeResponseSchema = z.object({
  updated: z.boolean(),
  media: internalMediaSchema.nullable(),
});

export type InternalMediaDescribeResponse = z.infer<typeof internalMediaDescribeResponseSchema>;

/**
 * Outbound sends over the internal API (Phase 2 slice D) — the calls that
 * need something back from the source (a delivered message id, a refusal
 * reason) or carry bytes, which the fire-and-forget bus events cannot do:
 * voice replies (TTS audio), generated images, browsing acknowledgements
 * (their id is registered for later deletion), message deletes, and the
 * assistant's reactions. Plain text replies keep travelling as
 * reply-delivery bus events.
 */

/** POST /internal/chats/:chatId/messages — send a text message, mirrored. */
export const internalSendMessageRequestSchema = z.object({
  text: z.string().min(1),
  /** Source-local message id to attach the send to as a reply, or null. */
  replyToSourceMessageId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
  /** Send without a notification ping (transient acknowledgements). */
  silent: z.boolean().default(false),
});

export const internalSentMessageResponseSchema = z.object({
  sourceMessageId: z.string().min(1),
});

export type InternalSentMessageResponse = z.infer<typeof internalSentMessageResponseSchema>;

/**
 * POST /internal/chats/:chatId/voice — deliver a reply as a voice bubble.
 * `audioBase64` is OGG/Opus (the one encoding Telegram renders as a voice
 * message); `text` is the spoken text, which is what the source mirrors.
 * The source falls back to a text send when the voice send is refused and
 * reports what it actually delivered.
 */
export const internalSendVoiceRequestSchema = z.object({
  audioBase64: z.string().min(1),
  text: z.string().min(1),
  replyToSourceMessageId: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});

export const internalSentVoiceResponseSchema = z.object({
  sourceMessageId: z.string().min(1),
  asVoice: z.boolean(),
});

export type InternalSentVoiceResponse = z.infer<typeof internalSentVoiceResponseSchema>;

/**
 * POST /internal/chats/:chatId/photos — deliver generated images. Each
 * delivered photo becomes the same pair of rows an incoming media message
 * produces in the source's store (an assistant mirror row + a pending media
 * row), so the vision describer recognizes what the bot drew exactly like a
 * user-sent picture (v1 decision, 2026-07-17, carried across the split).
 */
export const internalSendPhotosRequestSchema = z.object({
  images: z.array(z.string().min(1)).min(1),
  threadId: z.string().nullable().optional(),
});

export const internalSentPhotosResponseSchema = z.object({
  delivered: z.array(
    z.object({
      sourceMessageId: z.string().min(1),
      /** False when the photo was sent but its media row could not be stored. */
      stored: z.boolean(),
    }),
  ),
});

export type InternalSentPhotosResponse = z.infer<typeof internalSentPhotosResponseSchema>;

/**
 * DELETE /internal/chats/:chatId/messages/:messageId — remove one of the
 * assistant's own messages (a browsing acknowledgement whose run reported,
 * a stale feedback menu). `deleted: false` means the platform refused
 * (Telegram rejects deletes older than 48h) — cosmetic for every caller.
 */
export const internalDeleteMessageResponseSchema = z.object({
  deleted: z.boolean(),
});

export type InternalDeleteMessageResponse = z.infer<typeof internalDeleteMessageResponseSchema>;

/**
 * POST /internal/chats/:chatId/messages/:messageId/reaction — set (or, with
 * a null emoji, clear) the assistant's reaction badge on a message. The
 * source checks its mirror first: `not_found` (an id the model guessed) and
 * `own_message` (reacting to itself) are refused without touching the
 * platform; the core's tool words the refusals. A platform refusal (an
 * emoji this chat does not allow, a message too old) is a 502 whose error
 * message the tool relays verbatim.
 */
export const internalReactionRequestSchema = z.object({
  /** The canonical Telegram reaction emoji, or null to clear. */
  emoji: z.string().nullable(),
  big: z.boolean().default(false),
});

export const internalReactionResponseSchema = z.object({
  status: z.enum(["ok", "not_found", "own_message"]),
  /**
   * Whether the reaction was also recorded on the mirror row (the bot's
   * memory of reacting) — false degrades exactly like v1: the reaction IS
   * on the message, later turns may not remember it.
   */
  recorded: z.boolean().default(false),
});

export type InternalReactionResponse = z.infer<typeof internalReactionResponseSchema>;
