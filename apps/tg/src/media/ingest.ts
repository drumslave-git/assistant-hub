import type { TransportMedia } from "@assistant-hub-swarm/contracts";
import type { Message } from "@grammyjs/types";

import { detectMessageMedia } from "./detect";
import { VIDEO_FRAME_COUNT, extractVideoFrames } from "./frames";
import { normalizeImageForChat } from "./normalize";
import { downloadTelegramFile } from "./telegram-files";
import type { DetectedMedia, ImagePayload } from "./types";

/**
 * Media loading — the transport's half of ingestion since the Phase 7
 * de-storing: every incoming media message is downloaded with the
 * connection's token and normalized to bounded JPEG (frames sampled for
 * video/GIF, raw bytes kept for voice); the payload rides the update event
 * and the CORE stores it. Media that cannot be loaded travels as an
 * `unavailable` marker — recorded, never re-attempted, never lost.
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
    return {
      images: [],
      audio: { base64: raw.base64, mimeHint: raw.mimeHint },
      hint: detected.visionHint,
    };
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
 * Load a message's media into the payload the update event carries, or null
 * when the message carries no media at all. A payload that cannot be loaded
 * comes back as the `unavailable` marker (empty frames) — the core records
 * it and the turn still runs on the text.
 */
export async function loadMessageMedia(params: {
  token: string;
  message: Message;
  download?: FileDownloader;
}): Promise<TransportMedia | null> {
  const detected = detectMessageMedia(params.message);
  if (!detected) return null;
  const download = params.download ?? downloadTelegramFile;

  const loaded = await loadDetectedMedia(download, params.token, detected).catch(() => null);
  if (!loaded) {
    return {
      kind: detected.kind,
      fileId: detected.fileId,
      fileUniqueId: detected.fileUniqueId,
      mimeType: null,
      visionHint: detected.visionHint,
      frames: [],
      unavailable: true,
    };
  }
  return {
    kind: detected.kind,
    fileId: detected.fileId,
    fileUniqueId: detected.fileUniqueId,
    mimeType: loaded.audio ? loaded.audio.mimeHint : loaded.images[0].mimeHint,
    visionHint: loaded.hint,
    frames: loaded.audio ? [loaded.audio.base64] : loaded.images.map((image) => image.base64),
    unavailable: false,
  };
}
