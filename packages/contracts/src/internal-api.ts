import { z } from "zod";

/**
 * A transport's INTERNAL HTTP API — the calls the core makes on a transport
 * that need something back (a delivered message's id, the platform's own
 * refusal) or that carry bytes, which the fire-and-forget bus events cannot.
 * Authenticated by the shared `x-internal-token` header; reached only from
 * the core's server code, never a browser. Both sides parse these schemas,
 * which is what keeps them in lockstep without importing each other's code.
 *
 * It is a **sends-only** surface. It once carried reads too — media rows and
 * feedback rows, when each transport owned its own store — and those went
 * with the Phase 7 de-storing: the core owns the conversation store, so
 * there is nothing left to ask a transport for.
 */

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
  /** Core-resolved whitelist for `#<id>` citation links in `text`. */
  linkableSourceMessageIds: z.array(z.string().min(1)).optional(),
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
 * POST /internal/chats/:chatId/files — deliver a file (a browser-run
 * download), sent as playable media where the container allows (the source
 * picks sendVideo/sendAudio/sendDocument by mime, with a document retry).
 * The caption, when given, is what the source mirrors as the delivered
 * message's content — for a report-bearing send the report IS the message.
 */
export const internalSendFileRequestSchema = z.object({
  dataBase64: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().nullable().optional(),
  caption: z.string().nullable().optional(),
  threadId: z.string().nullable().optional(),
});

export const internalSentFileResponseSchema = z.object({
  sourceMessageId: z.string().min(1),
});

export type InternalSentFileResponse = z.infer<typeof internalSentFileResponseSchema>;

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
 * PUT /internal/chats/:chatId/title — name a conversation whose source asked
 * for one (`chatInfo.titleProvisional`). Served only by sources whose
 * conversations have no name of their own; the answer carries what was
 * actually stored.
 */
export const internalSetTitleRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const internalSetTitleResponseSchema = z.object({
  title: z.string().min(1),
});

/**
 * POST /internal/chats/:chatId/menu — post an inline-keyboard menu into a
 * chat (the feedback flow's options menu, driven by the core since the
 * Phase 7 de-storing). The keyboard is a plain button grid the transport
 * converts to its platform's shape.
 */
export const internalSendMenuRequestSchema = z.object({
  text: z.string().min(1),
  keyboard: z.array(z.array(z.object({ text: z.string().min(1), callbackData: z.string().min(1) }))),
  replyToSourceMessageId: z.string().min(1),
});

export const internalSentMenuResponseSchema = z.object({
  sourceMessageId: z.string().min(1),
});

/**
 * PATCH /internal/chats/:chatId/menu/:messageId — rewrite a previously sent
 * menu (`keyboard: null` removes the buttons). DELETE on the same path
 * removes the menu message (platform refusals are cosmetic).
 */
export const internalEditMenuRequestSchema = z.object({
  text: z.string().min(1),
  keyboard: z
    .array(z.array(z.object({ text: z.string().min(1), callbackData: z.string().min(1) })))
    .nullable(),
});
