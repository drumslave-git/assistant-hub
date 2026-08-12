import "server-only";

import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, GrammyError, HttpError, InputFile, type Context } from "grammy";

import { renderTelegramHtml } from "@/features/bot-messaging/telegram-html";
import { getTelegramBotToken } from "@/features/settings/server/service";
import { messageLinkBase, telegramFileKind, type TelegramFileKind } from "@/lib/telegram";
import { publishEvent } from "@/server/realtime/hub";

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
 *
 * Losing the network is a normal event, not a crash: the poller is supervised
 * here (see {@link FETCH_RETRY_WINDOW_MS}) so a connection that comes back finds
 * the bot reconnecting on its own, and Stop always answers.
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
  /** Armed reconnect attempt after a network drop, or null. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the poller is *meant* to be up — only then do we reconnect. */
  desired: boolean;
}

const STORE_KEY = Symbol.for("llm-tg-bot.telegram.bot-manager");

const STOPPED: BotStatus = { state: "stopped", username: null, since: null, error: null };

/**
 * How long the runner's own fetch loop may keep retrying a failing `getUpdates`
 * before it gives up and rejects its task.
 *
 * The runner's default is 15 hours of *uncapped doubling* backoff, which is why
 * a multi-hour outage left the bot dead long after the connection came back: by
 * then the next attempt had been scheduled hours out. That sleep is also not
 * interruptible, so it wedged Stop as well (see {@link stopBotInternal}).
 * Bounded here so a drop surfaces within a window, and this module owns the
 * reconnecting instead — on a fixed interval that never grows.
 */
const FETCH_RETRY_WINDOW_MS = 30_000;

/** Delay between reconnect attempts while the bot is down on a network error. */
const RECONNECT_DELAY_MS = 15_000;

/** Bound on the Telegram handshake, so a black-holed route can't wedge a start. */
const INIT_TIMEOUT_MS = 20_000;

/**
 * How long `stopBot` waits for the poller to unwind before detaching it. The
 * abort itself is synchronous, so the detached loop can never fetch again — this
 * only caps how long the caller (and the transition lock) is held.
 */
const STOP_DRAIN_TIMEOUT_MS = 3_000;

function store(): ManagerStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: ManagerStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      bot: null,
      runner: null,
      status: { ...STOPPED },
      transitioning: false,
      reconnectTimer: null,
      desired: false,
    };
  }
  return g[STORE_KEY];
}

/** Current bot status. Cheap and synchronous — safe for status probes. */
export function getBotStatus(): BotStatus {
  return { ...store().status };
}

/**
 * Record a state change and publish it on the shared `status` topic, so the
 * shell's Bot status card (and anything else watching) updates live — a poller
 * that dies or reconnects must not need a page reload to be seen.
 */
function setStatus(s: ManagerStore, status: BotStatus): void {
  s.status = status;
  publishEvent("status");
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

/** The Telegram handshake outran {@link INIT_TIMEOUT_MS}; treated as a network drop. */
class HandshakeTimeoutError extends Error {}

/**
 * `bot.init()` (getMe) with a deadline. Grammy's own client timeout is 500s —
 * long enough for a stalled connection to hold the transition lock, and the
 * dashboard request queued behind it, for most of a coffee break. The abandoned
 * request is left to that timeout to reap; its `Bot` instance is discarded here
 * either way, and `Promise.race` stays subscribed, so a late rejection cannot
 * surface unhandled.
 */
async function initWithDeadline(bot: Bot): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      bot.init(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new HandshakeTimeoutError(
                `Telegram did not answer getMe within ${INIT_TIMEOUT_MS / 1000}s`,
              ),
            ),
          INIT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a failure is worth reconnecting over. `HttpError` is grammy's "the
 * HTTP call itself failed" — an unreachable network, DNS, a timeout — which is
 * exactly the case that heals by itself. A `GrammyError` means Telegram answered
 * and refused (401 revoked token, 409 another poller), and retrying that in a
 * loop only produces noise, so it settles as a plain error for the operator.
 */
function isTransientNetworkError(err: unknown): boolean {
  return err instanceof HttpError || err instanceof HandshakeTimeoutError;
}

function cancelReconnect(s: ManagerStore): void {
  if (!s.reconnectTimer) return;
  clearTimeout(s.reconnectTimer);
  s.reconnectTimer = null;
}

/**
 * Record a poller failure and, when it is the kind that heals, arm the next
 * attempt. Logging is edge-triggered: an outage that lasts hours writes one line
 * on the way down and one on the way back up, not one per attempt.
 */
function failAndMaybeReconnect(s: ManagerStore, err: unknown, username: string | null): void {
  const reconnecting = s.desired && isTransientNetworkError(err);
  if (s.status.state !== "error") {
    console.error(
      `Telegram polling is down: ${errorMessage(err)}${
        reconnecting ? ` — reconnecting every ${RECONNECT_DELAY_MS / 1000}s` : ""
      }`,
    );
  }
  setStatus(s, {
    state: "error",
    username,
    since: null,
    error: reconnecting
      ? `${errorMessage(err)} — reconnecting automatically`
      : errorMessage(err),
  });
  cancelReconnect(s);
  if (!reconnecting) return;
  s.reconnectTimer = setTimeout(() => {
    s.reconnectTimer = null;
    // `startBot` re-arms this itself when the attempt fails the same way, so one
    // timer is in flight at a time however long the outage lasts. A throw (the
    // database being unreachable too, say) must not end up unhandled — and is
    // not a network failure, so it settles the loop rather than spinning on it.
    void startBot().catch((err: unknown) => failAndMaybeReconnect(s, err, null));
  }, RECONNECT_DELAY_MS);
  // A pending retry must not be a reason for the process to stay alive.
  s.reconnectTimer.unref?.();
}

/** Grammy `Context` as the outbound sink for the pipeline. */
function grammyTransport(ctx: Context): ReplyTransport {
  return {
    async sendReply(text, opts) {
      const params = {
        // `allow_sending_without_reply` matters because the target is no longer
        // always the message we are answering: a turn can aim its reply at an
        // older message it found. Telegram rejects the whole send when the target
        // is gone (deleted, or beyond what it will quote), and losing the answer
        // to save the pointer is the wrong trade — without the flag, a stale
        // target costs the user their reply.
        reply_parameters: {
          message_id: opts.replyToMessageId,
          allow_sending_without_reply: true,
        },
        ...(opts.silent ? { disable_notification: true } : {}),
      };
      const messageLinks = {
        baseUrl: messageLinkBase(String(ctx.chat!.id)),
        ids: opts.linkableMessageIds ?? [],
      };
      try {
        const sent = await ctx.reply(renderTelegramHtml(text, messageLinks), {
          ...params,
          parse_mode: "HTML",
        });
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
          // Same reasoning as the text reply above: the voice answer must arrive
          // even when its reply target no longer exists.
          reply_parameters: {
            message_id: opts.replyToMessageId,
            allow_sending_without_reply: true,
          },
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
  // Any caller of `startBot` — operator, autostart, or the reconnect timer —
  // wants the poller up; that intent is what keeps reconnecting alive.
  s.desired = true;
  cancelReconnect(s);
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    if (s.bot || s.runner) await stopBotInternal(s);

    const token = await getTelegramBotToken();
    if (!token) {
      // Not an error — the bot simply isn't configured yet. Kept as `stopped`
      // so the dashboard doesn't show a stale "error" once a token is saved.
      s.desired = false;
      setStatus(s, { ...STOPPED });
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
      // getMe — validates the token and populates bot.botInfo.
      await initWithDeadline(bot);
    } catch (err) {
      // The handshake fails on exactly the outage the poller would hit, so it
      // reconnects on the same terms rather than settling as a dead error.
      failAndMaybeReconnect(s, err, null);
      return { ...s.status };
    }

    if (!s.desired) {
      // A Stop landed while the handshake was in flight — honour it rather than
      // bringing up a poller nobody asked for.
      setStatus(s, { ...STOPPED });
      return { ...s.status };
    }

    const recovered = s.status.state === "error";
    s.bot = bot;
    setStatus(s, {
      state: "running",
      username: bot.botInfo.username,
      since: new Date().toISOString(),
      error: null,
    });
    if (recovered) console.log(`Telegram bot @${bot.botInfo.username} reconnected`);

    // Concurrent long-polling loop via the runner; not awaited (its task
    // resolves only when the bot stops, and rejects on a crash).
    // `message_reaction` is opt-in: it must be listed here or Telegram never
    // delivers it (and in groups the bot must additionally be an admin).
    const runner = run(bot, {
      runner: {
        fetch: {
          allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
        },
        // See FETCH_RETRY_WINDOW_MS: give up on a failing fetch loop quickly and
        // let the supervisor below reconnect on a flat interval.
        maxRetryTime: FETCH_RETRY_WINDOW_MS,
      },
    });
    s.runner = runner;
    const username = bot.botInfo.username;
    void runner.task()?.catch((err) => {
      // A runner we already stopped or replaced can still reject afterwards
      // (its detached fetch loop unwinding); only the current one may report.
      if (s.runner !== runner) return;
      s.bot = null;
      s.runner = null;
      failAndMaybeReconnect(s, err, username);
    });

    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}

async function stopBotInternal(s: ManagerStore): Promise<void> {
  cancelReconnect(s);
  const runner = s.runner;
  if (runner) {
    // `stop()` aborts the pending getUpdates synchronously; the promise it hands
    // back settles only once the fetch loop has unwound, and a loop asleep in a
    // retry backoff cannot be woken. Detach after a bounded wait rather than hold
    // the caller — and the transition lock — open for that sleep. Safe: the
    // aborted loop throws on its next fetch, so no second poller can appear.
    await Promise.race([
      Promise.resolve(runner.stop()).catch((err: unknown) => {
        console.error("Failed to stop Telegram bot:", errorMessage(err));
      }),
      new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
    ]);
    s.runner = null;
  }
  s.bot = null;
  setStatus(s, { ...STOPPED });
}

/** Stop the poller, cancelling any pending reconnect. Idempotent. */
export async function stopBot(): Promise<BotStatus> {
  const s = store();
  // Withdraw the intent first: a reconnect attempt that is already in flight
  // sees this and settles as stopped instead of bringing the poller back.
  s.desired = false;
  cancelReconnect(s);
  if (s.transitioning) return { ...s.status };
  s.transitioning = true;
  try {
    await stopBotInternal(s);
    return { ...s.status };
  } finally {
    s.transitioning = false;
  }
}
