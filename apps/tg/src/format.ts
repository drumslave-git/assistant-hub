/**
 * Pure formatting helpers this app resolves for the source contract: sender
 * labels and media annotations. Ports of the v1 helpers
 * (`features/known-users/format.ts`, `features/vision/format.ts`) — the label
 * and suffix shapes are part of prompt parity, byte-for-byte.
 */

export interface UserLabelParts {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  userId: string;
}

/** Human label for a user: name, @username, or a fallback id. */
export function formatUserLabel(user: UserLabelParts): string {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  if (name && user.username) return `${name} (@${user.username})`;
  if (name) return name;
  if (user.username) return `@${user.username}`;
  return `User ${user.userId}`;
}

/** Fallback speaker label when a sender cannot be resolved to a stored user. */
export function fallbackUserLabel(userId: string | null): string {
  return userId ? `User ${userId}` : "User";
}

const MEDIA_KIND_LABEL: Record<string, string> = {
  photo: "photo",
  sticker: "sticker",
  image_document: "image",
  animation: "GIF",
  video: "video",
  voice: "voice message",
};

/** Human label for a media kind. */
export function mediaKindLabel(kind: string): string {
  return MEDIA_KIND_LABEL[kind] ?? "image";
}

/**
 * The annotation appended to a history line for a media message, so a past
 * image turn reads as text: ` [photo: <description>]` once described,
 * ` [photo]` while pending, ` [photo unavailable]` when it could not be read.
 */
export function renderMediaNote(media: {
  kind: string;
  description: string | null;
  status: string;
}): string {
  const label = mediaKindLabel(media.kind);
  if (media.status === "described" && media.description) {
    return ` [${label}: ${media.description}]`;
  }
  if (media.status === "unavailable") {
    return ` [${label} unavailable]`;
  }
  return ` [${label}]`;
}
