import "server-only";

import sharp from "sharp";

import type { ImagePayload } from "../types";

/**
 * Normalize any Telegram image (WebP stickers, PNGs, oversized photos) to a
 * bounded JPEG so OpenAI-compatible vision endpoints accept it reliably and the
 * base64 stays small enough to store and send. Ported from the MVP.
 */

/** Longest edge (px) for a vision image. A code constant, not a setting. */
export const VISION_MAX_DIMENSION = 768;

/** Hard cap on the encoded image; providers reject very large payloads. */
const MAX_BYTES = 900_000;

/** Strip any data-URI prefix and whitespace, returning the raw image bytes. */
function parseBase64(input: string): Buffer {
  const trimmed = input.trim().replace(/\s/g, "");
  const raw = trimmed.includes(",") ? trimmed.slice(trimmed.indexOf(",") + 1) : trimmed;
  const buf = Buffer.from(raw, "base64");
  if (buf.length < 16) throw new Error("Image data is too small or corrupt");
  return buf;
}

function isJpeg(buf: Buffer): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}

/**
 * Resize/re-encode to a JPEG within {@link VISION_MAX_DIMENSION} and
 * {@link MAX_BYTES}. A small JPEG already in bounds is passed through untouched.
 * Throws when the image cannot be brought under the size cap.
 */
export async function normalizeImageForChat(
  base64: string,
  maxDimension: number = VISION_MAX_DIMENSION,
): Promise<ImagePayload> {
  const buf = parseBase64(base64);

  if (isJpeg(buf) && buf.length <= MAX_BYTES) {
    const meta = await sharp(buf).metadata();
    if ((meta.width ?? 0) <= maxDimension && (meta.height ?? 0) <= maxDimension) {
      return { base64: buf.toString("base64"), mimeHint: "image/jpeg" };
    }
  }

  let output = await sharp(buf, { failOn: "error" })
    .rotate()
    .resize(maxDimension, maxDimension, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();

  if (output.length > MAX_BYTES) {
    output = await sharp(output)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
  }

  if (output.length > MAX_BYTES) throw new Error("Image is too large after compression");
  return { base64: output.toString("base64"), mimeHint: "image/jpeg" };
}
