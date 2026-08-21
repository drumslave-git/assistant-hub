import type { ChatContentPart } from "@/server/llm/client";

import type { ImagePayload, MediaAnnotation, MediaKind } from "./types";

/**
 * Pure formatting helpers for vision: how media reads in a transcript, how an
 * image becomes a model content part, and human labels. No server imports, so
 * they are unit-testable in isolation.
 */

const KIND_LABEL: Record<MediaKind, string> = {
  photo: "photo",
  sticker: "sticker",
  image_document: "image",
  animation: "GIF",
  video: "video",
  voice: "voice message",
};

/** Human label for a media kind. */
export function mediaKindLabel(kind: MediaKind): string {
  return KIND_LABEL[kind] ?? "image";
}

/**
 * The suffix appended to a transcript line for a media message, so a past image
 * turn reads as text. `[photo: <description>]` once described; `[photo]` while
 * still pending (bytes not yet captioned); `[photo unavailable]` when it could
 * not be read.
 */
export function renderMediaSuffix(annotation: MediaAnnotation): string {
  const label = mediaKindLabel(annotation.kind);
  if (annotation.status === "described" && annotation.description) {
    return ` [${label}: ${annotation.description}]`;
  }
  if (annotation.status === "unavailable") {
    return ` [${label} unavailable]`;
  }
  return ` [${label}]`;
}

/** Build the OpenAI `image_url` content part for a normalized image. */
export function toImagePart(image: ImagePayload): ChatContentPart {
  return { type: "image_url", image_url: { url: `data:${image.mimeHint};base64,${image.base64}` } };
}

/**
 * Tell the model a set of images is an ordered clip, not unrelated pictures.
 * Used both as the reply/describe preamble and stored as the row's vision hint.
 */
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

/**
 * Turn images into content parts. A single image is one part; multiple images
 * (video/GIF frames) are labelled `Frame k of n:` and interleaved so the model
 * reads them as an ordered sequence rather than a bag of pictures.
 */
export function toVisionParts(images: ImagePayload[]): ChatContentPart[] {
  if (images.length <= 1) return images.map(toImagePart);
  const parts: ChatContentPart[] = [];
  images.forEach((image, i) => {
    parts.push({ type: "text", text: `Frame ${i + 1} of ${images.length}:` });
    parts.push(toImagePart(image));
  });
  return parts;
}

/**
 * Assemble a vision `user` turn: the turn's text followed by the image part(s).
 * Multiple frames are labelled and ordered (see {@link toVisionParts}). When
 * there is no text, a minimal instruction stands in so the model has something
 * to answer.
 */
export function buildVisionContent(text: string, images: ImagePayload[]): ChatContentPart[] {
  const prompt = text.trim() || "Respond to this image.";
  return [{ type: "text", text: prompt }, ...toVisionParts(images)];
}
