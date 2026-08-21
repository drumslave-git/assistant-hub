import type { ChatContentPart } from "@/server/llm/client";
import type { ImagePayload } from "@/features/vision/types";

/**
 * Reusable vision fixtures. A normalized image is just a base64 blob plus a
 * mime hint, and a vision turn carries `image_url` data-URL parts. These are
 * used as *inputs* to the messaging/describe/sanitize code under test — the
 * tests that assert on the exact produced data URL keep their own literal
 * expectations so a builder bug can't hide a regression.
 */

/** A tiny sample normalized image (base64 "A", JPEG). */
export const sampleImage: ImagePayload = { base64: "A", mimeHint: "image/jpeg" };

/** A three-frame sequence (base64 "A"/"B"/"C") for ordered-frame tests. */
export const sampleFrames: ImagePayload[] = [
  { base64: "A", mimeHint: "image/jpeg" },
  { base64: "B", mimeHint: "image/jpeg" },
  { base64: "C", mimeHint: "image/jpeg" },
];

/** Build an `image_url` content part carrying a base64 data URL. */
export function imagePart(base64: string, mime = "image/jpeg"): ChatContentPart {
  return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
}
