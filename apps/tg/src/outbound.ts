import type { ReactionTypeEmoji } from "@grammyjs/types";
import { GrammyError, InputFile, type Bot } from "grammy";

import { messageLinkBase, telegramFileKind, type TelegramFileKind } from "./telegram";
import { renderTelegramHtml } from "./telegram-html";

/**
 * Outbound Telegram operations on a running bot — the v1 grammy transport
 * (`server/telegram/bot-manager.ts` + `transport.ts`) ported to the source
 * split. This is the ONE place model text meets Telegram: Markdown is
 * rendered to Telegram HTML, whitelisted `#<id>` citations become tappable
 * message links, and a rejected render falls back to the plain text — the
 * raw model text is always deliverable, formatting is best-effort.
 */

/** Everything the delivery consumer and the internal API send through. */
export interface TgOutbound {
  /**
   * Send a text message, optionally attached as a reply.
   * `linkableMessageIds` is the mirror-checked whitelist for `#<id>` links;
   * `silent` sends without a notification ping (transient acknowledgements).
   */
  sendMessage(
    chatId: string,
    text: string,
    opts?: {
      replyToMessageId?: number | null;
      threadId?: number | null;
      silent?: boolean;
      linkableMessageIds?: readonly number[];
    },
  ): Promise<SentMessage>;
  /**
   * Deliver a reply as a Telegram voice bubble. `base64` is OGG/Opus audio —
   * the one encoding Telegram renders as a voice message (anything else
   * shows as a music file).
   */
  sendVoice(
    chatId: string,
    voice: { base64: string; filename: string },
    opts?: { replyToMessageId?: number | null; threadId?: number | null },
  ): Promise<{ messageId: number }>;
  /**
   * Deliver an image as a photo. Returns the Telegram `file_id` of the
   * stored photo alongside the message id: a generated image is stored as
   * ordinary media so the describer recognizes it, and that row is keyed by
   * the file Telegram just minted — it can only come from here.
   */
  sendPhoto(
    chatId: string,
    image: { base64: string; filename: string },
    opts?: { replyToMessageId?: number | null; threadId?: number | null },
  ): Promise<{ messageId: number; fileId: string; fileUniqueId: string | null }>;
  /**
   * Deliver a file (a browser-run download), picking the send method by
   * content type so a video or track plays straight in Telegram instead of
   * arriving as a bare attachment. The caption is rendered like any bot
   * message (HTML with a plain-text fallback), and a container Telegram
   * refuses as its playable kind is retried as a document — the message was
   * not delivered, so the retry cannot double-send.
   */
  sendFile(
    chatId: string,
    file: { base64: string; filename: string; mime?: string | null },
    opts?: { threadId?: number | null; caption?: string | null },
  ): Promise<{ messageId: number }>;
  /** Delete one of the bot's own messages. Telegram refuses deletes older than 48h. */
  deleteMessage(chatId: string, messageId: number): Promise<void>;
  /** Post an inline-keyboard menu (the feedback flow's options menu). */
  sendMenu(
    chatId: string,
    menu: { text: string; keyboard: MenuGrid; replyToMessageId: number },
  ): Promise<{ messageId: number }>;
  /** Rewrite a previously sent menu (`null` keyboard removes the buttons). */
  editMenu(
    chatId: string,
    messageId: number,
    menu: { text: string; keyboard: MenuGrid | null },
  ): Promise<void>;
  /**
   * Set (or, with null, clear) the bot's one reaction badge on a message.
   * Throws on refusal (an emoji this chat does not allow, a message too old)
   * so the caller can report it — a swallowed failure would leave the model
   * telling the chat it reacted.
   */
  setReaction(
    chatId: string,
    messageId: number,
    emoji: string | null,
    opts?: { big?: boolean },
  ): Promise<void>;
  /** Show the "typing…" chat action once (the caller owns the refresh loop). */
  sendTyping(chatId: string, threadId?: number | null): void;
}

/** A plain button grid the adapter converts to a Telegram inline keyboard. */
export type MenuGrid = { text: string; callbackData: string }[][];

function toInlineKeyboard(keyboard: MenuGrid) {
  return {
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  };
}

/**
 * Telegram rejected the rendered HTML entities (a converter blind spot, e.g.
 * a nesting Telegram forbids). Only this failure falls back to a plain-text
 * send — anything else (network, chat gone) must surface to the caller, and
 * a blind retry could double-deliver.
 */
function isEntityParseError(err: unknown): boolean {
  return (
    err instanceof GrammyError && err.description.toLowerCase().includes("can't parse entities")
  );
}

/**
 * What Telegram actually delivered. `replyToMessageId` is read back off the
 * sent message rather than echoed from the request: `allow_sending_without_reply`
 * means a target Telegram will not attach is dropped SILENTLY, and the mirror
 * (and the trace) must record what is in the chat, not what was asked for.
 */
export interface SentMessage {
  messageId: number;
  /** The message this one actually replies to, or null when none was attached. */
  replyToMessageId: number | null;
}

function delivered(sent: {
  message_id: number;
  reply_to_message?: { message_id: number };
}): SentMessage {
  return {
    messageId: sent.message_id,
    replyToMessageId: sent.reply_to_message?.message_id ?? null,
  };
}

/** Reply/thread params shared by the send methods. */
function sendParams(opts?: {
  replyToMessageId?: number | null;
  threadId?: number | null;
  silent?: boolean;
}) {
  return {
    ...(opts?.replyToMessageId != null
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            // Losing the answer to save the pointer is the wrong trade — a
            // stale reply target must not cost the user their message (v1).
            allow_sending_without_reply: true,
          },
        }
      : {}),
    ...(opts?.threadId != null ? { message_thread_id: opts.threadId } : {}),
    ...(opts?.silent ? { disable_notification: true } : {}),
  };
}

/**
 * The outbound ops over a lazily-resolved bot. `requireBot` throws when no
 * matching connection runs — the caller (delivery consumer, internal API)
 * surfaces that as its own failure.
 */
export function createBotOutbound(requireBot: () => Bot): TgOutbound {
  return {
    async sendMessage(chatId, text, opts) {
      const bot = requireBot();
      const params = sendParams(opts);
      const messageLinks = {
        baseUrl: messageLinkBase(chatId),
        ids: opts?.linkableMessageIds ?? [],
      };
      try {
        const sent = await bot.api.sendMessage(chatId, renderTelegramHtml(text, messageLinks), {
          ...params,
          parse_mode: "HTML",
        });
        return delivered(sent);
      } catch (err) {
        if (!isEntityParseError(err)) throw err;
        const sent = await bot.api.sendMessage(chatId, text, params);
        return delivered(sent);
      }
    },
    async sendVoice(chatId, voice, opts) {
      const bot = requireBot();
      const sent = await bot.api.sendVoice(
        chatId,
        new InputFile(Buffer.from(voice.base64, "base64"), voice.filename),
        sendParams(opts),
      );
      return { messageId: sent.message_id };
    },
    async sendPhoto(chatId, image, opts) {
      const bot = requireBot();
      const sent = await bot.api.sendPhoto(
        chatId,
        new InputFile(Buffer.from(image.base64, "base64"), image.filename),
        sendParams(opts),
      );
      // Telegram returns the photo in several rendered sizes, largest last.
      // The largest is the one worth describing and re-reading later,
      // matching how incoming photos are picked up (`detectMessageMedia`).
      const largest = sent.photo?.[sent.photo.length - 1];
      return {
        messageId: sent.message_id,
        fileId: largest?.file_id ?? "",
        fileUniqueId: largest?.file_unique_id ?? null,
      };
    },
    async sendFile(chatId, file, opts) {
      const bot = requireBot();
      const base = opts?.threadId != null ? { message_thread_id: opts.threadId } : {};
      // A fresh InputFile per attempt — grammy consumes the wrapper on send.
      const media = () => new InputFile(Buffer.from(file.base64, "base64"), file.filename);
      const sendAs: Record<
        TelegramFileKind,
        (extra: { caption?: string; parse_mode?: "HTML" }) => Promise<{ message_id: number }>
      > = {
        video: (extra) =>
          bot.api.sendVideo(chatId, media(), { ...base, supports_streaming: true, ...extra }),
        audio: (extra) => bot.api.sendAudio(chatId, media(), { ...base, ...extra }),
        document: (extra) => bot.api.sendDocument(chatId, media(), { ...base, ...extra }),
      };
      const caption = opts?.caption ?? undefined;
      const sendWithCaption = async (kind: TelegramFileKind) => {
        if (!caption) return sendAs[kind]({});
        try {
          return await sendAs[kind]({ caption: renderTelegramHtml(caption), parse_mode: "HTML" });
        } catch (err) {
          if (!isEntityParseError(err)) throw err;
          return sendAs[kind]({ caption });
        }
      };
      const kind = telegramFileKind(file.mime);
      try {
        const sent = await sendWithCaption(kind);
        return { messageId: sent.message_id };
      } catch (err) {
        // Telegram refused the media *as this kind* (a container its player
        // cannot take) — the message was not delivered, so a document retry
        // cannot double-send. Anything non-Grammy (network, chat gone) must
        // surface.
        if (kind === "document" || !(err instanceof GrammyError)) throw err;
        const sent = await sendWithCaption("document");
        return { messageId: sent.message_id };
      }
    },
    async deleteMessage(chatId, messageId) {
      await requireBot().api.deleteMessage(chatId, messageId);
    },
    async sendMenu(chatId, menu) {
      const sent = await requireBot().api.sendMessage(chatId, menu.text, {
        reply_parameters: { message_id: menu.replyToMessageId },
        reply_markup: toInlineKeyboard(menu.keyboard),
      });
      return { messageId: sent.message_id };
    },
    async editMenu(chatId, messageId, menu) {
      await requireBot().api.editMessageText(chatId, messageId, menu.text, {
        // Editing without `reply_markup` drops the inline keyboard.
        ...(menu.keyboard ? { reply_markup: toInlineKeyboard(menu.keyboard) } : {}),
      });
    },
    async setReaction(chatId, messageId, emoji, opts) {
      // The canonical-emoji check is the core tool's job (it words the
      // refusal for the model); Telegram enforces the set regardless, and a
      // refusal throws here for the caller to relay.
      const reaction = emoji ? [{ type: "emoji", emoji } as ReactionTypeEmoji] : [];
      await requireBot().api.setMessageReaction(chatId, messageId, reaction, {
        is_big: opts?.big ?? false,
      });
    },
    sendTyping(chatId, threadId) {
      const bot = requireBot();
      void bot.api
        .sendChatAction(chatId, "typing", threadId != null ? { message_thread_id: threadId } : {})
        .catch(() => undefined);
    },
  };
}
