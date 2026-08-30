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

/**
 * GET /internal/media/pending?limit=N — the backfill's work list: pending
 * rows the source is willing to hand over (live-processing holds respected,
 * oldest first), plus the whole backlog size. Byte-free — the describe pass
 * fetches each row's frames when it gets to it.
 */
export const internalPendingMediaResponseSchema = z.object({
  media: z.array(
    z.object({
      id: z.string().min(1),
      chatId: z.string().min(1),
      sourceMessageId: z.string().min(1),
    }),
  ),
  total: z.number().int().nonnegative(),
});

export type InternalPendingMediaResponse = z.infer<typeof internalPendingMediaResponseSchema>;

/**
 * GET /internal/media/recent?limit=N — the newest media rows (the dashboard
 * gallery). Frames ride along for pending rows only; a described row's
 * bytes are gone by design.
 */
export const internalRecentMediaResponseSchema = z.object({
  media: z.array(internalMediaSchema),
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
 * One feedback row as served over the internal API (the raw material lives
 * in the source's store; the core's learning jobs read and stamp it here).
 * Field names mirror the store row: `feedback` is the user's answer text.
 */
export const internalFeedbackSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  /** Source-local id of the reacted assistant reply. */
  sourceMessageId: z.string().min(1),
  userId: z.string().min(1),
  reaction: z.enum(["up", "down"]),
  feedback: z.string().nullable(),
  status: z.enum(["pending", "awaiting_text", "completed"]),
  topic: z.enum(["quality", "addressing"]),
  /** Clean model name of the reacted reply; stamped by the core (write-back). */
  model: z.string().nullable(),
  reflection: z.string().nullable(),
  reflectionModel: z.string().nullable(),
  prefsVersion: z.number().int().nullable(),
  correctionsVersion: z.number().int().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type InternalFeedback = z.infer<typeof internalFeedbackSchema>;

/**
 * GET /internal/feedbacks — all rows newest first (the dashboard listing);
 * `?needs=prefs` / `?needs=corrections` narrows to the completed `quality`
 * rows the matching fold has not incorporated yet, oldest first (the daily
 * job's backlogs; `addressing` rows are deliberately invisible to both).
 */
export const internalFeedbacksResponseSchema = z.object({
  feedbacks: z.array(internalFeedbackSchema),
});

/** GET /internal/feedbacks/:id and the PATCH response. */
export const internalFeedbackResponseSchema = z.object({
  feedback: internalFeedbackSchema.nullable(),
});

/**
 * PATCH /internal/feedbacks/:id — the core's write-backs onto a feedback
 * row: the reacted reply's model (resolved from the reply trace, which only
 * the core can read), the reflection, and the fold-version stamps.
 */
export const internalFeedbackPatchRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    reflection: z.string().min(1).optional(),
    reflectionModel: z.string().min(1).optional(),
    prefsVersion: z.number().int().positive().optional(),
    correctionsVersion: z.number().int().positive().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty patch" });

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
