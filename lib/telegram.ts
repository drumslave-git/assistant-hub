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
