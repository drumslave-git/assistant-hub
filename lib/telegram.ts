/**
 * Pure facts about Telegram identifiers, single-sourced so the assumption is
 * written down once. Client-safe (no server dependencies).
 */

/**
 * Whether a chat id names a group/supergroup rather than a private chat.
 * Telegram encodes the kind in the sign: a private chat's id is the (positive)
 * user id, a group's is negative. If Telegram ever changes this, this is the
 * one place that knows.
 */
export function isGroupChatId(chatId: string): boolean {
  return chatId.startsWith("-");
}

/**
 * The Bot API's upload ceiling in MB: no bot can send a larger file, so it is a
 * fact about Telegram, not a tunable (user decision, 2026-08-01 — replaced the
 * `browser_download_max_mb` setting). Raising it beyond 50 requires a local Bot
 * API server, tracked in `docs/TODO.md`.
 */
export const TELEGRAM_MAX_UPLOAD_MB = 50;

/**
 * How a reply cites a message it is talking about: `#13488`, or the numero sign
 * (`№`, written as an escape to keep this source ASCII) that a model reaches
 * for in some languages. Anchored to a boundary so a URL fragment
 * (`example.com/a#12`) and a word-shaped hashtag (`#weekend`) are both left
 * alone — only a delimiter followed by digits counts.
 *
 * Single-sourced because two places must agree exactly on what a citation is: the
 * pipeline, which checks each id really exists before linking it, and the HTML
 * renderer, which turns the surviving ones into anchors. A regex that drifted
 * between them would produce links to messages that do not exist.
 */
export const MESSAGE_REF_PATTERN = /(^|[\s(\[«"'—-])([#№])(\d{1,12})\b/gu;

/** Every message id a text cites, de-duplicated, in first-appearance order. */
export function findMessageRefs(text: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(MESSAGE_REF_PATTERN)) {
    const id = Number(match[3]);
    if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The `t.me` prefix a message link is built on for this chat, or null when the
 * chat has no linkable form.
 *
 * Only supergroups and channels do. Telegram gives their ids a `-100` prefix over
 * the internal id used in links, so `-1001234567890` links as
 * `t.me/c/1234567890/<message id>`. A basic group and a private chat have no
 * per-message URL at all — returning null there is what keeps the bot from
 * writing links that go nowhere.
 */
export function messageLinkBase(chatId: string): string | null {
  const internal = chatId.startsWith("-100") ? chatId.slice(4) : null;
  if (!internal || !/^\d+$/.test(internal)) return null;
  return `https://t.me/c/${internal}`;
}

/** How a file should be sent so Telegram renders it best — see {@link telegramFileKind}. */
export type TelegramFileKind = "video" | "audio" | "document";

/** Containers Telegram clients actually stream inline as a video bubble. */
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime"]);

/** Formats Telegram shows in the music player (.mp3 / .m4a per the Bot API docs). */
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/mp4"]);

/**
 * The send method that makes a file playable straight in the chat: `sendVideo`
 * for a streamable video, `sendAudio` for a music-player format, `sendDocument`
 * for everything else. Deliberately conservative — a container outside the
 * supported lists (mkv, webm, opus …) is rendered as a generic file by Telegram
 * anyway, and sending it as a document at least names it honestly.
 */
export function telegramFileKind(mime: string | null | undefined): TelegramFileKind {
  const normalized = (mime ?? "").split(";")[0].trim().toLowerCase();
  if (VIDEO_MIMES.has(normalized)) return "video";
  if (AUDIO_MIMES.has(normalized)) return "audio";
  return "document";
}
