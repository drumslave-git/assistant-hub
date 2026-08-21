/**
 * Shared vision types. Client-safe (no server imports) so both the server
 * services and the dashboard/debug UI can import them.
 */

/**
 * The kinds of media the bot can read from a Telegram message: the visual kinds
 * (described by the vision model) plus `voice` (transcribed by the audio-capable
 * chat model — the transcript plays the role of the description).
 */
export const MEDIA_KINDS = [
  "photo",
  "sticker",
  "image_document",
  "animation",
  "video",
  "voice",
] as const;

/** The union, derived from the list so a new kind cannot be added to only one. */
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Lifecycle status of a stored media row. */
export type MediaStatus = "pending" | "described" | "unavailable";

/** A normalized image ready for the vision model: base64 JPEG + mime hint. */
export interface ImagePayload {
  base64: string;
  mimeHint: string;
}

/**
 * The vision-capable media found on a Telegram message, before download. Enough
 * to fetch the bytes and to record the row.
 */
export interface DetectedMedia {
  kind: MediaKind;
  /**
   * The concrete file to read. For a photo/sticker/image document this is the
   * image itself; for a video/GIF (`animation`/`video`) it is the actual media
   * file, from which frames are sampled with ffmpeg.
   */
  fileId: string;
  fileUniqueId: string | null;
  /** A sticker's emoji / pack hint, folded into the describe prompt. */
  visionHint: string | null;
  /**
   * Whether `fileId` points at a video/GIF that must be frame-sampled (ffmpeg)
   * rather than decoded as a still image.
   */
  isVideo: boolean;
  /**
   * Whether `fileId` points at audio (a voice message) whose bytes are stored
   * as-is (OGG/Opus) and transcribed rather than decoded as an image.
   */
  isAudio: boolean;
  /**
   * Telegram's single-frame JPEG thumbnail, used as a fallback when frame
   * extraction is unavailable/fails. Null when the message carries no thumbnail.
   */
  thumbnailFileId: string | null;
  /** Media duration in seconds (video/animation/voice), for scaling the frame count / capping transcription. */
  durationSec: number | null;
}

/**
 * How a stored media row is surfaced in the history transcript: a short kind
 * marker plus (once described) the model's text description.
 */
export interface MediaAnnotation {
  kind: MediaKind;
  status: MediaStatus;
  description: string | null;
}

/**
 * A media row shaped for the dashboard. Pending rows carry a `preview` data URL
 * (the stored image) so the operator can see un-captioned media; described rows
 * carry the text `description` instead (their bytes are gone). Client-safe.
 */
export interface MediaView {
  id: string;
  chatId: string;
  telegramMessageId: number;
  kind: MediaKind;
  status: MediaStatus;
  description: string | null;
  /** `data:<mime>;base64,…` for a pending row with bytes, else null (first frame for a video). */
  preview: string | null;
  /** All sampled frames as data URLs for a pending video/GIF, else null. */
  frames: string[] | null;
  createdAt: string;
  describedAt: string | null;
}
