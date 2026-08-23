import { randomUUID } from "node:crypto";

import type { Message } from "@grammyjs/types";

import type { TgDb } from "../db";
import { detectMessageMedia } from "./detect";
import { VIDEO_FRAME_COUNT, extractVideoFrames } from "./frames";
import { normalizeImageForChat } from "./normalize";
import { getMediaByMessage, insertMedia, insertUnavailableMedia } from "./store";
import { downloadTelegramFile } from "./telegram-files";
import type { DetectedMedia, ImagePayload, StoredMedia } from "./types";

/**
 * Media ingestion — the v1 vision service's ingest half
 * (`ingestMessageMedia`), ported with the source split: every incoming media
 * message is downloaded with the connection's token, normalized to bounded
 * JPEG (frames sampled for video/GIF, raw bytes kept for voice), and stored
 * `pending` in this app's store. The DESCRIBE half (vision/STT models) is
 * the core's, over the internal media API; the stored row is the handoff.
 *
 * Best-effort like v1: media that cannot be loaded is recorded
 * `unavailable` (never re-attempted, never lost); a re-delivered update
 * finds and returns the existing row.
 */

/** Injectable downloader (tests); the default hits the Telegram file API. */
export type FileDownloader = (
  token: string,
  fileId: string,
) => Promise<{ base64: string; mimeHint: string } | null>;

interface LoadedMedia {
  images: ImagePayload[];
  audio: { base64: string; mimeHint: string } | null;
  hint: string | null;
}

async function loadImage(
  download: FileDownloader,
  token: string,
  fileId: string,
): Promise<ImagePayload | null> {
  try {
    const raw = await download(token, fileId);
    if (!raw) return null;
    return await normalizeImageForChat(raw.base64);
  } catch {
    return null;
  }
}

/** Frame-sequence hint, matching the v1 `frameSequenceHint` wording exactly. */
export function frameSequenceHint(kind: "animation" | "video", frameCount: number): string {
  const noun = kind === "animation" ? "GIF" : "video";
  if (frameCount <= 1) return `The image is a still frame from the user's ${noun}.`;
  return (
    `The next ${frameCount} images are consecutive frames from the user's ${noun}, in ` +
    "chronological order (frame 1 is earliest, the last is most recent). They are NOT " +
    "separate or unrelated images — read them together as one moving clip and describe " +
    "what happens across the frames over time."
  );
}

async function loadVideoFrames(
  download: FileDownloader,
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  const raw = await download(token, detected.fileId);
  if (!raw) return null;
  const input = Buffer.from(raw.base64, "base64");
  const frames = await extractVideoFrames(input, {
    count: VIDEO_FRAME_COUNT,
    durationSec: detected.durationSec,
  });
  if (frames.length === 0) return null;
  const images = await Promise.all(
    frames.map((frame) => normalizeImageForChat(frame.toString("base64"))),
  );
  const kind = detected.kind === "animation" ? "animation" : "video";
  return { images, audio: null, hint: frameSequenceHint(kind, images.length) };
}

async function loadDetectedMedia(
  download: FileDownloader,
  token: string,
  detected: DetectedMedia,
): Promise<LoadedMedia | null> {
  if (detected.isAudio) {
    const raw = await download(token, detected.fileId).catch(() => null);
    if (!raw) return null;
    return { images: [], audio: { base64: raw.base64, mimeHint: raw.mimeHint }, hint: detected.visionHint };
  }
  if (!detected.isVideo) {
    const image = await loadImage(download, token, detected.fileId);
    return image ? { images: [image], audio: null, hint: detected.visionHint } : null;
  }
  // Video/GIF: sample frames with ffmpeg; on any failure fall back to the
  // Telegram single-frame thumbnail so the media is still recognized.
  const sequence = await loadVideoFrames(download, token, detected).catch(() => null);
  if (sequence) return sequence;
  if (detected.thumbnailFileId) {
    const thumb = await loadImage(download, token, detected.thumbnailFileId);
    if (thumb) {
      const kind = detected.kind === "animation" ? "animation" : "video";
      return { images: [thumb], audio: null, hint: frameSequenceHint(kind, 1) };
    }
  }
  return null;
}

/**
 * Ingest a message's media into this app's store. Returns the stored row
 * (fresh, existing on re-delivery, or the `unavailable` marker's absence as
 * null), or null when the message carries no media at all.
 */
export async function ingestMessageMedia(
  params: {
    db: TgDb;
    token: string;
    chatId: string;
    telegramMessageId: number;
    message: Message;
    download?: FileDownloader;
  },
): Promise<StoredMedia | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;
  const download = params.download ?? downloadTelegramFile;

  const loaded = await loadDetectedMedia(download, params.token, detected);
  if (!loaded) {
    await insertUnavailableMedia(params.db, {
      id: randomUUID(),
      chatId: params.chatId,
      telegramMessageId: params.telegramMessageId,
      kind: detected.kind,
      fileId: detected.fileId,
      fileUniqueId: detected.fileUniqueId,
      visionHint: detected.visionHint,
    }).catch(() => undefined);
    return getMediaByMessage(params.db, params.chatId, params.telegramMessageId).catch(() => null);
  }

  const inserted = await insertMedia(params.db, {
    id: randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: detected.kind,
    fileId: detected.fileId,
    fileUniqueId: detected.fileUniqueId,
    mimeType: loaded.audio ? loaded.audio.mimeHint : loaded.images[0].mimeHint,
    visionHint: loaded.hint,
    frames: loaded.audio ? [loaded.audio.base64] : loaded.images.map((image) => image.base64),
  }).catch(() => null);
  // Conflict (re-delivered update) → the existing row is the truth.
  return (
    inserted ??
    (await getMediaByMessage(params.db, params.chatId, params.telegramMessageId).catch(() => null))
  );
}

/**
 * A provenance note, not a description: the describer must look at the image
 * fresh, because generation models routinely miss or mangle parts of a
 * prompt — the whole reason the generated image is stored as ordinary media
 * is to learn what actually came out (v1 wording, verbatim).
 */
const GENERATED_IMAGE_HINT =
  "This image was generated by the bot itself, in response to a request in this chat.";

/**
 * Store an image the bot generated and just delivered, as ordinary pending
 * media keyed by the file id Telegram minted on send (v1
 * `ingestGeneratedImage`) — the describer then recognizes what the bot drew
 * exactly like a user-sent picture. Null when the bytes cannot be
 * normalized or the row cannot be stored (the photo is in the chat either
 * way; the caller reports `stored: false`).
 */
export async function ingestGeneratedImage(params: {
  db: TgDb;
  chatId: string;
  telegramMessageId: number;
  fileId: string;
  fileUniqueId: string | null;
  base64: string;
}): Promise<StoredMedia | null> {
  const normalized = await normalizeImageForChat(params.base64).catch(() => null);
  if (!normalized) return null;
  return insertMedia(params.db, {
    id: randomUUID(),
    chatId: params.chatId,
    telegramMessageId: params.telegramMessageId,
    kind: "photo",
    fileId: params.fileId,
    fileUniqueId: params.fileUniqueId,
    mimeType: normalized.mimeHint,
    visionHint: GENERATED_IMAGE_HINT,
    frames: [normalized.base64],
  }).catch(() => null);
}
