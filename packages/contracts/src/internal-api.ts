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
