import "server-only";

import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, GrammyError, InputFile, type Context } from "grammy";

import { renderTelegramHtml } from "@/features/bot-messaging/telegram-html";
import { getTelegramBotToken } from "@/features/settings/server/service";
import { telegramFileKind, type TelegramFileKind } from "@/lib/telegram";

import { processCallbackUpdate } from "./process-callback";
import { processReactionUpdate } from "./process-reaction";
import { processEditedUpdate, processUpdate } from "./process-update";
import type { FeedbackTransport, IncomingUpdate, ReplyTransport } from "./transport";

/**
 * In-process Telegram bot lifecycle (long polling), owned by a single manager.
 *
 * Per the recorded decision: the poller runs inside the Next.js server process
 * (started from `instrumentation.ts`), not a separate worker. Telegram permits
 * exactly one `getUpdates` consumer per token, so exactly one poller may run —
 * enforced here by a `globalThis` singleton that survives module re-evaluation
 * across Next bundles (instrumentation vs. Route Handlers) and dev hot-reload.
 *
 * Updates are processed **concurrently across chats** via `@grammyjs/runner`
 * (user decision, 2026-07-20), with `sequentialize` keeping each chat strictly
 * in order. Concurrency-audited: the typing loop is a per-call closure with its
 * own timer, and the MCP tool context is `AsyncLocalStorage`-bound per turn —
 * neither shares mutable per-update state.
 *
 * This module is now only the Telegram *edge*: the poller lifecycle plus a thin
 * grammy adapter that maps a live `Context` onto the transport-agnostic
 * {@link processUpdate} pipeline. All message-handling logic lives in
 * `process-update.ts`, so it runs identically without a bot (see `test/simulate`).
 */

export type BotState = "stopped" | "running" | "error";

export interface BotStatus {
  state: BotState;
  username: string | null;
  /** ISO time the current run started, or null when not running. */
  since: string | null;
  /** Last error message when `state` is `error`, else null. */
  error: string | null;
}

interface ManagerStore {
  bot: Bot | null;
  /** The concurrent polling loop for the current bot, when running. */
  runner: RunnerHandle | null;
  status: BotStatus;
  /** Guards against overlapping start/stop calls. */
  transitioning: boolean;
}

const STORE_KEY = Symbol.for("llm-tg-bot.telegram.bot-manager");

const STOPPED: BotStatus = { state: "stopped", username: null, since: null, error: null };

function store(): ManagerStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ManagerStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { bot: null, runner: null, status: { ...STOPPED }, transitioning: false };
  }
  return g[STORE_KEY];
}

/** Current bot status. Cheap and synchronous — safe for status probes. */
export function getBotStatus(): BotStatus {
  return { ...store().status };
}

/**
 * Send an out-of-band message to a chat, outside any incoming update (used by the
 * scheduled-tasks fire path). Requires the poller to be running — Telegram's `api`
 * lives on the active bot. Throws when the bot is not running so the caller can
 * record the failure. Resolves the delivered message id.
 */
export async function sendChatMessage(
  chatId: string,
  text: string,
  opts: { threadId?: number | null; silent?: boolean } = {},
): Promise<{ messageId: number }> {
  const bot = store().bot;
  if (!bot) throw new Error("Telegram bot is not running");
  const base = {
    ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
    ...(opts.silent ? { disable_notification: true } : {}),
  };
  try {
    const sent = await bot.api.sendMessage(chatId, renderTelegramHtml(text), {
      ...base,
      parse_mode: "HTML",
    });
    return { messageId: sent.message_id };
  } catch (err) {
    if (!isEntityParseError(err)) throw err;
    const sent = await bot.api.sendMessage(chatId, text, base);
    return { messageId: sent.message_id };
  }
}

/**
 * Send an out-of-band file to a chat (used by the browser-agent runner to
 * deliver a downloaded file), picking the send method by content type so a video
 * or track plays straight in Telegram instead of arriving as a bare attachment.
 * The caption is rendered like any bot message (HTML with a plain-text fallback).
 * Requires the poller to be running — Telegram's `api` lives on the active bot.
 * Throws when the bot is not running so the caller can record the failure.
 * Resolves the delivered message id.
 */
export async function sendChatFile(
  chatId: string,
  file: { buffer: Buffer; filename: string; mime?: string },
  opts: { threadId?: number | null; caption?: string } = {},
): Promise<{ messageId: number }> {
  const bot = store().bot;
  if (!bot) throw new Error("Telegram bot is not running");
  const base = opts.threadId != null ? { message_thread_id: opts.threadId } : {};
  // A fresh InputFile per attempt — grammy consumes the wrapper on send.
  const media = () => new InputFile(file.buffer, file.filename);
  const sendAs: Record<
    TelegramFileKind,
    (extra: { caption?: string; parse_mode?: "HTML" }) => Promise<{ message_id: number }>
  > = {
    video: (extra) =>
      bot.api.sendVideo(chatId, media(), { ...base, supports_streaming: true, ...extra }),
    audio: (extra) => bot.api.sendAudio(chatId, media(), { ...base, ...extra }),
    document: (extra) => bot.api.sendDocument(chatId, media(), { ...base, ...extra }),
  };
  const sendWithCaption = async (kind: TelegramFileKind) => {
    if (!opts.caption) return sendAs[kind]({});
    try {
      return await sendAs[kind]({ caption: renderTelegramHtml(opts.caption), parse_mode: "HTML" });
    } catch (err) {
      if (!isEntityParseError(err)) throw err;
      return sendAs[kind]({ caption: opts.caption });
    }
  };
  const kind = telegramFileKind(file.mime);
  try {
    const sent = await sendWithCaption(kind);
    return { messageId: sent.message_id };
  } catch (err) {
    // Telegram refused the media *as this kind* (a container its player cannot
    // take) — the message was not delivered, so a document retry cannot
    // double-send. Anything non-Grammy (network, chat gone) must surface.
    if (kind === "document" || !(err instanceof GrammyError)) throw err;
    const sent = await sendWithCaption("document");
    return { messageId: sent.message_id };
  }
}

/**
 * Delete a bot message from a chat (used by the browser-agent runner to remove
 * its own "on it" acknowledgement once the run has reported). Telegram refuses
 * deletes older than 48h — callers treat a failure as cosmetic.
 */
export async function deleteChatMessage(chatId: string, messageId: number): Promise<void> {
  const bot = store().bot;
  if (!bot) throw new Error("Telegram bot is not running");
  await bot.api.deleteMessage(chatId, messageId);
}

/**
 * Telegram rejected the rendered HTML entities (a converter blind spot, e.g. a
 * nesting Telegram forbids). Only this failure falls back to a plain-text send —
 * anything else (network, chat gone) must surface to the caller, and a blind
 * retry could double-deliver.
 */
function isEntityParseError(err: unknown): boolean {
  return err instanceof GrammyError && err.description.toLowerCase().includes("can't parse entities");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Grammy `Context` as the outbound sink for the pipeline. */
function grammyTransport(ctx: Context): ReplyTransport {
  return {
    async sendReply(text, opts) {
      const params = {
        reply_parameters: { message_id: opts.replyToMessageId },
        ...(opts.silent ? { disable_notification: true } : {}),
      };
      try {
        const sent = await ctx.reply(renderTelegramHtml(text), { ...params, parse_mode: "HTML" });
        return { messageId: sent.message_id };
      } catch (err) {
        if (!isEntityParseError(err)) throw err;
        // The raw model text is always deliverable; formatting is best-effort.
        const sent = await ctx.reply(text, params);
        return { messageId: sent.message_id };
      }
    },
    async deleteMessage(opts) {
      await ctx.api.deleteMessage(String(ctx.chat!.id), opts.messageId);
    },
    async sendPhoto(image, opts) {
      const sent = await ctx.api.sendPhoto(
        String(ctx.chat!.id),
        new InputFile(Buffer.from(image.base64, "base64"), image.filename),
        {
          ...(opts.replyToMessageId != null
            ? { reply_parameters: { message_id: opts.replyToMessageId } }
            : {}),
          ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
        },
      );
      // Telegram returns the photo in several rendered sizes, largest last. The
      // largest is the one worth describing and re-reading later, matching how
      // incoming photos are picked up (`detectMessageMedia`).
      const largest = sent.photo?.[sent.photo.length - 1];
      return {
        messageId: sent.message_id,
        fileId: largest?.file_id ?? "",
        fileUniqueId: largest?.file_unique_id ?? null,
      };
    },
    async sendVoice(voice, opts) {
      const sent = await ctx.api.sendVoice(
        String(ctx.chat!.id),
        new InputFile(Buffer.from(voice.base64, "base64"), voice.filename),
        {
          reply_parameters: { message_id: opts.replyToMessageId },
          ...(opts.threadId != null ? { message_thread_id: opts.threadId } : {}),
        },
      );
      return { messageId: sent.message_id };
    },
    sendTyping(opts) {
      const other =
        opts.threadId != null ? { message_thread_id: opts.threadId } : undefined;
      void ctx.replyWithChatAction("typing", other).catch(() => undefined);
    },
  };
}

/** Grammy `Context` as the feedback-menu sink (reaction menus + presses). */
function grammyFeedbackTransport(ctx: Context): FeedbackTransport {
  const toInlineKeyboard = (keyboard: { text: string; callbackData: string }[][]) => ({
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  });
  return {
    async sendMenu(input) {
      const sent = await ctx.api.sendMessage(input.chatId, input.text, {
        reply_parameters: { message_id: input.replyToMessageId },
        reply_markup: toInlineKeyboard(input.keyboard),
      });
      return { messageId: sent.message_id };
    },
    async editMenu(input) {
      await ctx.api.editMessageText(input.chatId, input.messageId, input.text, {
        // Editing without `reply_markup` drops the inline keyboard.
        ...(input.keyboard ? { reply_markup: toInlineKeyboard(input.keyboard) } : {}),
      });
    },
    async deleteMenu(input) {
      await ctx.api.deleteMessage(input.chatId, input.messageId);
    },
    async answerCallback(input) {
      await ctx.api.answerCallbackQuery(input.callbackQueryId, {
        ...(input.text ? { text: input.text } : {}),
      });
    },
  };
}

/** Map a grammy message update onto the transport-agnostic pipeline. */
async function onMessage(ctx: Context): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.chat) return;

  const update: IncomingUpdate = {
    message,
    // `first_name` is the bot's display name — what people call it in a group,
    // as opposed to the @username they type. Both drive the addressing check.
    botInfo: { id: ctx.me.id, username: ctx.me.username, displayName: ctx.me.first_name },
    // The token is only needed when the turn carries media; resolve it lazily.
    resolveToken: () => getTelegramBotToken(),
  };
  const feedback = grammyFeedbackTransport(ctx);
  await processUpdate(update, grammyTransport(ctx), {
    // A captured feedback answer retires the menu message it answered.
    deleteFeedbackMenu: (input) => feedback.deleteMenu(input),
  });
}

/** Map a grammy `message_reaction` update onto the feedback flow. */
async function onReaction(ctx: Context): Promise<void> {
  const reaction = ctx.messageReaction;
  if (!reaction) return;
  await processReactionUpdate(reaction, grammyFeedbackTransport(ctx));
}

/** Map a grammy `callback_query` update onto the feedback-menu flow. */
async function onCallbackQuery(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  if (!query) return;
  await processCallbackUpdate(query, grammyFeedbackTransport(ctx));
}

/** Map a grammy `edited_message` update onto the history-edit mirror. */
async function onEditedMessage(ctx: Context): Promise<void> {
  const edited = ctx.editedMessage;
  if (!edited || !ctx.chat) return;
  await processEditedUpdate(edited);
}

/**
 * Start (or restart) the poller using the token from DB settings. Idempotent and
 * safe to call from autostart or a dashboard control. Returns the resulting
 * status; a missing/invalid token settles as `error` rather than throwing, so
 * boot never crashes on an unconfigured bot.
 */
export async function startBot(): Promise<BotStatus> {
  const s = store();
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    if (s.bot) await stopBotInternal(s);

    const token = await getTelegramBotToken();
    if (!token) {
      // Not an error — the bot simply isn't configured yet. Kept as `stopped`
      // so the dashboard doesn't show a stale "error" once a token is saved.
      s.status = { ...STOPPED };
      return { ...s.status };
    }

    const bot = new Bot(token);
    // Per-chat sequential, cross-chat concurrent (user decision, 2026-07-20 —
    // @grammyjs/runner): one chat's slow reply (tool rounds, a 300s image
    // generation) must not freeze every other chat, while order within a chat
    // is preserved. Must be registered before any handler.
    bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
    bot.on("message", (ctx) => onMessage(ctx));
    bot.on("edited_message", (ctx) => onEditedMessage(ctx));
    // Feedback collection: 👍/👎 reactions open a menu, presses answer it. In
    // groups Telegram only delivers `message_reaction` when the bot is an admin.
    bot.on("message_reaction", (ctx) => onReaction(ctx));
    bot.on("callback_query:data", (ctx) => onCallbackQuery(ctx));
    bot.catch((err) => {
      console.error("Telegram bot error:", err.error);
    });

    try {
      await bot.init(); // getMe — validates the token and populates bot.botInfo
    } catch (err) {
      s.status = { state: "error", username: null, since: null, error: errorMessage(err) };
      return { ...s.status };
    }

    s.bot = bot;
    s.status = {
      state: "running",
      username: bot.botInfo.username,
      since: new Date().toISOString(),
      error: null,
    };

    // Concurrent long-polling loop via the runner; not awaited (its task
    // resolves only when the bot stops, and rejects on a crash).
    // `message_reaction` is opt-in: it must be listed here or Telegram never
    // delivers it (and in groups the bot must additionally be an admin).
    const runner = run(bot, {
      runner: {
        fetch: {
          allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
        },
      },
    });
    s.runner = runner;
    void runner.task()?.catch((err) => {
      s.bot = null;
      s.runner = null;
      s.status = { ...s.status, state: "error", error: errorMessage(err) };
    });

    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}

async function stopBotInternal(s: ManagerStore): Promise<void> {
  if (s.runner) {
    try {
      // Interrupts the pending getUpdates call and resolves once every
      // in-flight update's middleware has finished — a clean drain.
      await s.runner.stop();
    } catch (err) {
      console.error("Failed to stop Telegram bot:", errorMessage(err));
    }
    s.runner = null;
  }
  s.bot = null;
  s.status = { ...STOPPED };
}

/** Stop the poller. Idempotent. */
export async function stopBot(): Promise<BotStatus> {
  const s = store();
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    await stopBotInternal(s);
    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}
