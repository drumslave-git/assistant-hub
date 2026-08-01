import type { Message } from "@grammyjs/types";

import type { BotIdentity } from "@/features/bot-messaging/server/addressing";
import type { MenuKeyboard } from "@/features/self-improvement/menu";

/**
 * Transport boundary between the Telegram edge and the message-processing
 * pipeline. The bot is only a *source of events* (an incoming update) and a
 * *sink* (reply + typing) — everything in between (remember, mirror, vision,
 * prompt, tools, LLM, trace) is transport-agnostic. Splitting this seam lets the
 * whole real pipeline run with no bot: the grammy adapter wraps a live `Context`,
 * a test harness wraps a synthetic update with a capturing sink.
 */

export type { BotIdentity };

/** A normalized incoming message update, decoupled from grammy's `Context`. */
export interface IncomingUpdate {
  /** The Telegram message (grammy / `@grammyjs/types` shape). */
  message: Message;
  /** The bot's own identity (id + username), used for addressing + labels. */
  botInfo: BotIdentity;
  /**
   * Resolve the Telegram bot token used to download media files (vision). Called
   * lazily — only when the turn actually carries media — so a text-only flow
   * never needs one. Returns null when unavailable (e.g. a simulated update with
   * no real Telegram files behind it).
   */
  resolveToken: () => Promise<string | null>;
}

/** The outbound sink: deliver replies + typing back to the originating chat. */
export interface ReplyTransport {
  /**
   * Deliver a reply, resolving with its delivered message id. `silent` sends it
   * without a notification ping — used for a turn whose reply is only an
   * acknowledgement of background work (a browsing run) that will report for
   * itself when done.
   */
  sendReply(
    text: string,
    opts: { replyToMessageId: number; threadId?: number; silent?: boolean },
  ): Promise<{ messageId: number }>;
  /**
   * Delete one of the bot's own messages. Optional (a capturing test transport
   * may not implement it); used to remove a browsing-run acknowledgement whose
   * run had already reported by the time the acknowledgement was delivered.
   */
  deleteMessage?(opts: { messageId: number }): Promise<void>;
  /**
   * Deliver a generated image as a photo, resolving with its delivered message id
   * and the Telegram `file_id` of the stored photo.
   *
   * The `file_id` is why this returns more than a message id: a generated image is
   * stored as ordinary media (`message_media`) so the vision describer recognizes
   * it like any user-sent picture, and that row is keyed by the file the *bot* just
   * created. Telegram only mints that id on send, so it can only come from here.
   */
  sendPhoto(
    image: { base64: string; filename: string },
    opts: { replyToMessageId?: number; threadId?: number },
  ): Promise<{ messageId: number; fileId: string; fileUniqueId: string | null }>;
  /**
   * Deliver a reply as a Telegram voice bubble. `base64` is OGG/Opus audio —
   * the one encoding Telegram renders as a voice message (anything else shows
   * as a music file). Used by the voice-to-voice reply path; the text form of
   * the reply is still what history mirrors and traces record.
   */
  sendVoice(
    voice: { base64: string; filename: string },
    opts: { replyToMessageId: number; threadId?: number },
  ): Promise<{ messageId: number }>;
  /**
   * Show the "typing…" chat action once. The pipeline owns the refresh loop
   * (Telegram expires the action after a few seconds), so this is a single tick.
   */
  sendTyping(opts: { threadId?: number }): void;
}

/**
 * Outbound ops the feedback-menu flows need (reaction → menu → answer). Same
 * seam pattern as {@link ReplyTransport}: a grammy adapter in the bot manager,
 * a capturing fake in the simulation harness.
 */
export interface FeedbackTransport {
  /** Post the options menu into the chat, resolving with its message id. */
  sendMenu(input: {
    chatId: string;
    text: string;
    keyboard: MenuKeyboard;
    replyToMessageId: number;
  }): Promise<{ messageId: number }>;
  /** Rewrite a previously sent menu message (`null` keyboard removes it). */
  editMenu(input: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard: MenuKeyboard | null;
  }): Promise<void>;
  /**
   * Remove a menu message once its answer is stored, so the chat keeps no
   * feedback chatter. Telegram refuses to delete messages older than 48h, so
   * callers treat a failure as cosmetic.
   */
  deleteMenu(input: { chatId: string; messageId: number }): Promise<void>;
  /** Answer a callback query (stops the button spinner; optional toast text). */
  answerCallback(input: { callbackQueryId: string; text?: string }): Promise<void>;
}
