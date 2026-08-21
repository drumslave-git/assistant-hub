import type { Document, Message, Sticker } from "@grammyjs/types";

import type { DetectedMedia, MediaKind } from "./types";

/**
 * Pure detection of vision-capable media on a Telegram message. Decides *what*
 * file to read and how to hint the describer — the actual download and frame
 * extraction live in the server-only modules. Client-safe (only `@grammyjs/types`,
 * which are types).
 *
 * Precedence mirrors the MVP, with one change: a video/GIF (`animation`/`video`,
 * which Telegram delivers as mp4) now points at the **actual media file** so the
 * server can sample frames with ffmpeg. Telegram's single-frame thumbnail is kept
 * as a fallback for when frame extraction is unavailable. Photos, image documents,
 * and static stickers are still decoded directly as still images.
 */

/** A short describe hint for a sticker: its emoji and pack name when present. */
function stickerHint(sticker: Sticker): string | null {
  const parts: string[] = [];
  if (sticker.emoji) parts.push(`Sticker emoji: ${sticker.emoji}`);
  if (sticker.set_name) parts.push(`Sticker pack: ${sticker.set_name}`);
  return parts.length > 0 ? parts.join(". ") : null;
}

/** True for a document that is really a video/gif (not a PDF etc.). */
function isVideoLikeDocument(document: Document): boolean {
  const mime = document.mime_type ?? "";
  return mime.startsWith("video/") || mime === "image/gif";
}

/**
 * The vision-capable media on a message, or null when there is none. Returns the
 * concrete `file_id` to read plus, for video/GIF media, the flag + thumbnail +
 * duration the server needs to sample frames.
 */
export function detectMessageMedia(message: Message): DetectedMedia | null {
  // Voice first: a voice message carries nothing else, and its handling (store
  // OGG bytes, transcribe) is disjoint from every image path below.
  if (message.voice) {
    const voice = message.voice;
    return {
      kind: "voice",
      fileId: voice.file_id,
      fileUniqueId: voice.file_unique_id ?? null,
      visionHint: null,
      isVideo: false,
      isAudio: true,
      thumbnailFileId: null,
      durationSec: voice.duration ?? null,
    };
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    return image("photo", photo.file_id, photo.file_unique_id, null);
  }

  if (message.sticker) {
    const sticker = message.sticker;
    const animated = sticker.is_animated || sticker.is_video;
    // Animated (.tgs) / video (.webm) stickers are not still images — read their
    // JPEG thumbnail. A static (.webp) sticker is decoded directly.
    const fileId = animated ? sticker.thumbnail?.file_id : sticker.file_id;
    const fileUniqueId = animated ? sticker.thumbnail?.file_unique_id : sticker.file_unique_id;
    if (!fileId) return null;
    return image("sticker", fileId, fileUniqueId ?? null, stickerHint(sticker));
  }

  if (message.document?.mime_type?.startsWith("image/") && message.document.mime_type !== "image/gif") {
    const doc = message.document;
    return image("image_document", doc.file_id, doc.file_unique_id, null);
  }

  const animated = message.animation ?? message.video;
  if (animated) {
    const kind: MediaKind = message.animation ? "animation" : "video";
    return video(kind, animated.file_id, animated.file_unique_id, {
      thumbnailFileId: animated.thumbnail?.file_id ?? null,
      durationSec: animated.duration ?? null,
    });
  }

  if (message.document && isVideoLikeDocument(message.document)) {
    const doc = message.document;
    const kind: MediaKind = doc.mime_type === "image/gif" ? "animation" : "video";
    return video(kind, doc.file_id, doc.file_unique_id, {
      thumbnailFileId: doc.thumbnail?.file_id ?? null,
      durationSec: null,
    });
  }

  return null;
}

/** A still image: decoded directly, no frame extraction. */
function image(
  kind: MediaKind,
  fileId: string,
  fileUniqueId: string | null,
  visionHint: string | null,
): DetectedMedia {
  return {
    kind,
    fileId,
    fileUniqueId,
    visionHint,
    isVideo: false,
    isAudio: false,
    thumbnailFileId: null,
    durationSec: null,
  };
}

/** A video/GIF: the server samples frames from `fileId` (thumbnail as fallback). */
function video(
  kind: MediaKind,
  fileId: string,
  fileUniqueId: string | null,
  opts: { thumbnailFileId: string | null; durationSec: number | null },
): DetectedMedia {
  return {
    kind,
    fileId,
    fileUniqueId,
    visionHint: null,
    isVideo: true,
    isAudio: false,
    thumbnailFileId: opts.thumbnailFileId,
    durationSec: opts.durationSec,
  };
}

/** Whether a message carries any readable media (visual or a voice message). */
export function messageHasVisionMedia(message: Message | undefined): boolean {
  return message ? detectMessageMedia(message) !== null : false;
}

/**
 * The first message in a reply chain (up to `maxDepth`) that carries
 * vision-capable media — so "what is this?" as a reply to an earlier image
 * resolves to that image.
 */
export function findReplyMediaMessage(
  message: Message | undefined,
  maxDepth = 4,
): Message | null {
  let current: Message | undefined = message?.reply_to_message;
  let depth = 0;
  while (current && depth < maxDepth) {
    if (messageHasVisionMedia(current)) return current;
    current = current.reply_to_message;
    depth++;
  }
  return null;
}
