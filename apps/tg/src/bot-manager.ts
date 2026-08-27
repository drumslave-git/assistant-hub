import { openPublisher, openQueue, type BusPublisher } from "@assistant-hub/bus";
import { busTraceClient, dashboardRefresh } from "@assistant-hub/service";
import {
  BUS_EVENTS_CHANNEL,
  INBOUND_MESSAGES_QUEUE,
  turnCorrelationId,
  type InboundMessageEvent,
  type SourceTraceClient,
} from "@assistant-hub/contracts";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, HttpError, type Context } from "grammy";

import type { AssistantConnection } from "./audience";
import { createCrossFeed, type CrossFeed } from "./cross-feed";
import type { TgDb } from "./db";
import {
  captureFeedbackReply,
  processCallbackUpdate,
  processReactionUpdate,
  type FeedbackDeps,
  type FeedbackTransport,
} from "./feedback/flows";
import { processIncomingMessage } from "./inbound";
import { createBotOutbound, type TgOutbound } from "./outbound";

import {
  applyMessageEdit,
  deleteConnectionsByAssistant,
  listEnabledConnections,
} from "./store";

/**
 * Poller lifecycle for this app's telegram connections — the v1 bot-manager
 * (`apps/core/server/telegram/bot-manager.ts`) ported to the source split:
 * tokens come from the connections table (one bot per assistant), updates
 * feed the transport-agnostic inbound processor which enqueues normalized
 * events, and outbound goes through the {@link TgSender} the delivery
 * consumer uses. Supervision semantics are v1's, kept verbatim: bounded
 * fetch-retry, flat-interval reconnect on transient network failures,
 * edge-triggered logging, bounded stop drain.
 *
 * Runs a poller per ENABLED connection (the store allows one per
 * assistant; a v1 migration yields at most one). Reconciliation from
 * desired state on operator command arrives with the operator API slice —
 * this boots what is enabled and supervises it.
 *
 * Updates handled: `message` / `edited_message` (slice A) plus
 * `message_reaction` / `callback_query` (slice D — the feedback flows,
 * tg-local now that feedbacks live in this store; completions go out as
 * `feedback.recorded` bus events for the core's learning jobs). In groups
 * Telegram only delivers `message_reaction` when the bot is an admin.
 */

export type ConnectionState = "running" | "error" | "stopped";

export interface ConnectionStatus {
  connectionId: string;
  assistantId: string;
  state: ConnectionState;
  username: string | null;
  since: string | null;
  error: string | null;
}

interface Poller {
  connectionId: string;
  assistantId: string;
  bot: Bot | null;
  runner: RunnerHandle | null;
  status: ConnectionStatus;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  desired: boolean;
}

/** See the v1 bot-manager for the reasoning behind each bound. */
const FETCH_RETRY_WINDOW_MS = 30_000;
const RECONNECT_DELAY_MS = 15_000;
const INIT_TIMEOUT_MS = 20_000;
const STOP_DRAIN_TIMEOUT_MS = 3_000;

class HandshakeTimeoutError extends Error {}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTransientNetworkError(err: unknown): boolean {
  return err instanceof HttpError || err instanceof HandshakeTimeoutError;
}

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

/** A running bot's API as the feedback-menu sink (reaction menus + presses). */
function grammyFeedbackTransport(bot: Bot): FeedbackTransport {
  const toInlineKeyboard = (keyboard: { text: string; callbackData: string }[][]) => ({
    inline_keyboard: keyboard.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    ),
  });
  return {
    async sendMenu(input) {
      const sent = await bot.api.sendMessage(input.chatId, input.text, {
        reply_parameters: { message_id: input.replyToMessageId },
        reply_markup: toInlineKeyboard(input.keyboard),
      });
      return { messageId: sent.message_id };
    },
    async editMenu(input) {
      await bot.api.editMessageText(input.chatId, input.messageId, input.text, {
        // Editing without `reply_markup` drops the inline keyboard.
        ...(input.keyboard ? { reply_markup: toInlineKeyboard(input.keyboard) } : {}),
      });
    },
    async deleteMenu(input) {
      await bot.api.deleteMessage(input.chatId, input.messageId);
    },
    async answerCallback(input) {
      await bot.api.answerCallbackQuery(input.callbackQueryId, {
        ...(input.text ? { text: input.text } : {}),
      });
    },
  };
}

export class BotManager {
  private pollers = new Map<string, Poller>();
  private queue: ReturnType<typeof openQueue<InboundMessageEvent>>;
  private publisher: BusPublisher;
  private traces: SourceTraceClient;
  /**
   * Hands an assistant's delivered message to the chat's other assistants
   * (`cross-feed.ts`). It lives here because this is where both halves it
   * needs already are: the queue producer, and the running bots' identities.
   */
  readonly crossFeed: CrossFeed;

  constructor(
    private readonly deps: {
      db: TgDb;
      redisUrl: string;
      onStatusChange?: (status: ConnectionStatus) => void;
    },
  ) {
    this.queue = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, deps.redisUrl);
    this.publisher = openPublisher(deps.redisUrl);
    this.traces = busTraceClient("tg", this.publisher);
    this.crossFeed = createCrossFeed({
      db: deps.db,
      running: () => this.runningConnections(),
      enqueue: (event) => this.enqueueInbound(event),
    });
  }

  /** Enqueue one normalized inbound event for the core's pipeline. */
  private async enqueueInbound(event: InboundMessageEvent): Promise<void> {
    await this.queue.add("message.inbound", event);
  }

  /**
   * Every connection with a live bot account. A stopped or still-connecting
   * poller is not one: it has no identity to put on an event and could not
   * deliver an answer either. Both shared-chat paths read this — the group
   * fan-out of an inbound message and the cross-feed of a reply.
   */
  private runningConnections(): AssistantConnection[] {
    return [...this.pollers.values()].flatMap((poller) =>
      poller.bot?.botInfo
        ? [
            {
              assistantId: poller.assistantId,
              botId: poller.bot.botInfo.id,
              identity: {
                botUsername: poller.bot.botInfo.username,
                botDisplayName: poller.bot.botInfo.first_name,
              },
            },
          ]
        : [],
    );
  }

  /** The feedback flows' collaborators over one running bot. */
  private feedbackDeps(bot: Bot, assistantId: string): FeedbackDeps {
    return {
      db: this.deps.db,
      assistantId,
      transport: grammyFeedbackTransport(bot),
      publish: (event) => this.publisher.publish(BUS_EVENTS_CHANNEL, event),
    };
  }

  /** Start a poller for every enabled connection. Boot entry. */
  async startEnabled(): Promise<ConnectionStatus[]> {
    const rows = await listEnabledConnections(this.deps.db);
    for (const row of rows) {
      await this.startConnection({
        connectionId: row.id,
        assistantId: row.assistantId,
        botToken: row.botToken,
      });
    }
    return this.statuses();
  }

  statuses(): ConnectionStatus[] {
    return [...this.pollers.values()].map((p) => ({ ...p.status }));
  }

  /**
   * The outbound ops for one assistant's connection (the delivery consumer
   * and the internal API both send through this). A null assistant means
   * "whichever connection runs" — with Phase 2's single connection, simply
   * the bot. Resolution is per call, so a poller restart never leaves a
   * stale handle behind.
   */
  senderFor(assistantId: string | null): TgOutbound {
    const requireBot = (): Bot => {
      const poller = [...this.pollers.values()].find(
        (p) => (assistantId == null || p.assistantId === assistantId) && p.bot,
      );
      if (!poller?.bot) {
        throw new Error(
          `No running telegram connection${assistantId ? ` for assistant ${assistantId}` : ""}`,
        );
      }
      return poller.bot;
    };
    return createBotOutbound(requireBot);
  }

  private setStatus(poller: Poller, status: Omit<ConnectionStatus, "connectionId" | "assistantId">): void {
    poller.status = {
      connectionId: poller.connectionId,
      assistantId: poller.assistantId,
      ...status,
    };
    this.deps.onStatusChange?.({ ...poller.status });
    // The dashboard's bot card watches `status` — a poller that dies or
    // reconnects must show up without a reload (v1 behavior, over the bus).
    void this.publisher
      .publish(BUS_EVENTS_CHANNEL, dashboardRefresh("tg", ["status"]))
      .catch(() => undefined);
  }

  private cancelReconnect(poller: Poller): void {
    if (!poller.reconnectTimer) return;
    clearTimeout(poller.reconnectTimer);
    poller.reconnectTimer = null;
  }

  private failAndMaybeReconnect(
    poller: Poller,
    err: unknown,
    input: { connectionId: string; assistantId: string; botToken: string },
    username: string | null,
  ): void {
    const reconnecting = poller.desired && isTransientNetworkError(err);
    if (poller.status.state !== "error") {
      console.error(
        `Telegram polling is down (${poller.connectionId}): ${errorMessage(err)}${
          reconnecting ? ` — reconnecting every ${RECONNECT_DELAY_MS / 1000}s` : ""
        }`,
      );
    }
    this.setStatus(poller, {
      state: "error",
      username,
      since: null,
      error: reconnecting
        ? `${errorMessage(err)} — reconnecting automatically`
        : errorMessage(err),
    });
    this.cancelReconnect(poller);
    if (!reconnecting) return;
    poller.reconnectTimer = setTimeout(() => {
      poller.reconnectTimer = null;
      void this.startConnection(input).catch((err: unknown) =>
        this.failAndMaybeReconnect(poller, err, input, null),
      );
    }, RECONNECT_DELAY_MS);
    poller.reconnectTimer.unref?.();
  }

  /** Start (or restart) one connection's poller. Idempotent. */
  async startConnection(input: {
    connectionId: string;
    assistantId: string;
    botToken: string;
  }): Promise<void> {
    let poller = this.pollers.get(input.connectionId);
    if (!poller) {
      poller = {
        connectionId: input.connectionId,
        assistantId: input.assistantId,
        bot: null,
        runner: null,
        status: {
          connectionId: input.connectionId,
          assistantId: input.assistantId,
          state: "stopped",
          username: null,
          since: null,
          error: null,
        },
        reconnectTimer: null,
        desired: false,
      };
      this.pollers.set(input.connectionId, poller);
    }
    poller.desired = true;
    this.cancelReconnect(poller);
    if (poller.bot || poller.runner) await this.stopPoller(poller);

    const bot = new Bot(input.botToken);
    // Per-chat sequential, cross-chat concurrent (v1 decision, 2026-07-20).
    bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
    bot.on("message", (ctx) => this.onMessage(poller, input.botToken, ctx));
    bot.on("edited_message", (ctx) => this.onEditedMessage(poller, ctx));
    // Feedback collection: 👍/👎 reactions open a menu, presses answer it.
    bot.on("message_reaction", (ctx) => this.onReaction(poller, bot, ctx));
    bot.on("callback_query:data", (ctx) => this.onCallbackQuery(poller, bot, ctx));
    bot.catch((err) => {
      console.error(`Telegram bot error (${input.connectionId}):`, err.error);
    });

    try {
      await initWithDeadline(bot);
    } catch (err) {
      this.failAndMaybeReconnect(poller, err, input, null);
      return;
    }
    if (!poller.desired) {
      this.setStatus(poller, { state: "stopped", username: null, since: null, error: null });
      return;
    }

    const recovered = poller.status.state === "error";
    poller.bot = bot;
    this.setStatus(poller, {
      state: "running",
      username: bot.botInfo.username,
      since: new Date().toISOString(),
      error: null,
    });
    if (recovered) console.log(`Telegram bot @${bot.botInfo.username} reconnected`);

    const runner = run(bot, {
      runner: {
        // `message_reaction` is opt-in: it must be listed here or Telegram
        // never delivers it (and in groups the bot must also be an admin).
        fetch: {
          allowed_updates: ["message", "edited_message", "message_reaction", "callback_query"],
        },
        maxRetryTime: FETCH_RETRY_WINDOW_MS,
      },
    });
    poller.runner = runner;
    const username = bot.botInfo.username;
    void runner.task()?.catch((err) => {
      if (poller.runner !== runner) return;
      poller.bot = null;
      poller.runner = null;
      this.failAndMaybeReconnect(poller, err, input, username);
    });
  }

  private async onMessage(poller: Poller, botToken: string, ctx: Context): Promise<void> {
    const message = ctx.message;
    if (!message || !ctx.chat) return;
    // This app's half of the turn, correlated the way the core's reply trace
    // is (`<chatId>:<messageId>`) so the whole cross-app flow filters as one.
    // Settled — and therefore published — only for a message that became an
    // inbound event, or that failed: plain mirrored chatter leaves nothing
    // behind (the v1 noise rule).
    const trace = this.traces.startTrace({
      feature: "bot-messaging",
      action: "inbound",
      assistantId: poller.assistantId,
      trigger: {
        kind: "telegram",
        actor: message.from ? String(message.from.id) : String(ctx.chat.id),
        // This poller's own turn. In a group the same message may open a turn
        // for other assistants too (the trace's enqueue event names them);
        // the mirroring and ingest below happen once, here.
        correlationId: turnCorrelationId(
          String(ctx.chat.id),
          String(message.message_id),
          poller.assistantId,
        ),
      },
      inputSummary: message.text ?? message.caption ?? "(media)",
    });
    try {
      const bot = poller.bot;
      const result = await processIncomingMessage(message, {
        db: this.deps.db,
        assistantId: poller.assistantId,
        identity: {
          botUsername: ctx.me.username,
          // `first_name` is the bot's display name — what people call it.
          botDisplayName: ctx.me.first_name,
        },
        botId: ctx.me.id,
        botToken,
        // A group message is a turn for every assistant in the chat;
        // Telegram delivers it to each bot but only one poller mirrors it.
        running: () => this.runningConnections(),
        enqueue: (event) => this.enqueueInbound(event),
        // A reply to an awaiting feedback menu is that menu's answer, not a
        // turn; the capture deletes the menu and publishes the completion.
        captureFeedback: bot
          ? async (input) =>
              (await captureFeedbackReply(input, this.feedbackDeps(bot, poller.assistantId))) !=
              null
          : undefined,
      });
      // The mirror and the directory just changed — ping the pages that
      // show them (best-effort; the message is already stored).
      void this.publisher
        .publish(BUS_EVENTS_CHANNEL, dashboardRefresh("tg", ["history", "users", "groups"]))
        .catch(() => undefined);
      if (result.status === "enqueued") {
        const events = result.events ?? [];
        trace.event({
          message:
            events.length > 1
              ? `inbound event enqueued for ${events.length} assistants`
              : "inbound event enqueued",
          type: "output",
          level: "success",
          data: {
            // Every turn this one message opened, so a group shared by
            // several assistants shows who was handed it and under which
            // correlation each of their turns runs.
            turns: events.map((event) => ({
              assistantId: event.assistantId,
              eventId: event.eventId,
              correlationId: event.correlationId,
              addressed: event.addressing.addressed,
            })),
          },
        });
        await trace.succeed({
          outputSummary:
            events.length > 1
              ? `enqueued for the core (${events.length} assistants)`
              : "enqueued for the core",
        });
      }
    } catch (err) {
      console.error(
        `Inbound processing failed for ${ctx.chat.id}:${message.message_id}:`,
        errorMessage(err),
      );
      await trace.fail(err);
    }
  }

  private async onReaction(poller: Poller, bot: Bot, ctx: Context): Promise<void> {
    const reaction = ctx.messageReaction;
    if (!reaction) return;
    // Correlated to the reacted reply's turn, like the completion event —
    // the menu, the answer, and the learning jobs all group under it.
    // Settles only when a menu actually opened (or on failure); ignored
    // reactions — other emoji, non-bot messages — leave nothing behind.
    const trace = this.traces.startTrace({
      feature: "self-improvement",
      action: "collect-feedback",
      assistantId: poller.assistantId,
      trigger: {
        kind: "telegram",
        actor: reaction.user ? String(reaction.user.id) : String(reaction.chat.id),
        correlationId: `${reaction.chat.id}:${reaction.message_id}`,
      },
      inputSummary: "reaction on a bot reply",
    });
    try {
      const outcome = await processReactionUpdate(
        reaction,
        this.feedbackDeps(bot, poller.assistantId),
      );
      if (outcome.status === "menu_sent") {
        trace.event({
          message: "feedback menu sent",
          type: "output",
          level: "success",
          data: { feedbackId: outcome.feedback.id, reaction: outcome.feedback.reaction },
        });
        await trace.succeed({ outputSummary: `menu sent (${outcome.feedback.reaction})` });
      }
    } catch (err) {
      console.error(
        `Reaction processing failed for ${reaction.chat.id}:${reaction.message_id}:`,
        errorMessage(err),
      );
      await trace.fail(err);
    }
  }

  private async onCallbackQuery(poller: Poller, bot: Bot, ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    if (!query) return;
    const chatId = query.message ? String(query.message.chat.id) : null;
    // Settles for a press that changed feedback state (answered, or flipped
    // to awaiting free text) or failed; foreign menus and stale presses drop.
    const trace = this.traces.startTrace({
      feature: "self-improvement",
      action: "collect-feedback",
      assistantId: poller.assistantId,
      trigger: {
        kind: "telegram",
        actor: String(query.from.id),
        ...(chatId && query.message
          ? { correlationId: `${chatId}:${query.message.message_id}` }
          : {}),
      },
      inputSummary: "feedback menu press",
    });
    try {
      const outcome = await processCallbackUpdate(
        query,
        this.feedbackDeps(bot, poller.assistantId),
      );
      if (outcome.status === "recorded") {
        trace.event({
          message: "feedback recorded",
          type: "output",
          level: "success",
          data: { feedbackId: outcome.feedback.id, answer: outcome.feedback.feedback },
        });
        await trace.succeed({
          outputSummary: outcome.feedback.feedback ?? "recorded",
          // The row lives in this store, but the completion's correlation is
          // the REACTED reply's turn (what the completion event carries).
          correlationId: `${outcome.feedback.chatId}:${outcome.feedback.telegramMessageId}`,
        });
      } else if (outcome.status === "awaiting_text") {
        trace.event({ message: "awaiting free-text answer", type: "step" });
        await trace.succeed({
          outputSummary: "awaiting free-text answer",
          correlationId: `${outcome.feedback.chatId}:${outcome.feedback.telegramMessageId}`,
        });
      }
    } catch (err) {
      console.error(`Callback processing failed for query ${query.id}:`, errorMessage(err));
      await trace.fail(err);
    }
  }

  private async onEditedMessage(poller: Poller, ctx: Context): Promise<void> {
    const edited = ctx.editedMessage;
    if (!edited || !ctx.chat) return;
    const content = edited.text ?? edited.caption ?? "";
    if (!content.trim()) return;
    await applyMessageEdit(this.deps.db, {
      chatId: String(edited.chat.id),
      telegramMessageId: edited.message_id,
      content,
      editedAt: new Date((edited.edit_date ?? edited.date) * 1000),
      assistantId: poller.assistantId,
    }).catch((err) => {
      console.error("Failed to mirror edited message:", errorMessage(err));
    });
  }

  /**
   * Reconcile one connection to its desired state (operator API writes):
   * enabled starts/restarts its poller (a token change takes effect by
   * restart — start is idempotent and always replaces the running bot),
   * disabled stops it. The status row stays for the listing.
   */
  async reconcileConnection(row: {
    id: string;
    assistantId: string;
    botToken: string;
    enabled: boolean;
  }): Promise<void> {
    if (row.enabled) {
      await this.startConnection({
        connectionId: row.id,
        assistantId: row.assistantId,
        botToken: row.botToken,
      });
      return;
    }
    const poller = this.pollers.get(row.id);
    if (poller) {
      poller.desired = false;
      await this.stopPoller(poller);
    }
  }

  /**
   * The `assistant.deleted` reaction: drop every connection keyed on the
   * assistant — rows deleted, pollers stopped — and ping the status pages.
   */
  async removeAssistant(assistantId: string): Promise<void> {
    const rows = await deleteConnectionsByAssistant(this.deps.db, assistantId);
    for (const row of rows) {
      await this.removeConnection(row.id);
    }
    if (rows.length > 0) {
      console.log(
        `assistant ${assistantId} deleted — dropped ${rows.length} connection(s) and stopped polling`,
      );
      void this.publisher
        .publish(BUS_EVENTS_CHANNEL, dashboardRefresh("tg", ["status"]))
        .catch(() => undefined);
    }
  }

  /** Stop a deleted connection's poller and drop it from the status listing. */
  async removeConnection(connectionId: string): Promise<void> {
    const poller = this.pollers.get(connectionId);
    if (!poller) return;
    poller.desired = false;
    await this.stopPoller(poller);
    this.pollers.delete(connectionId);
  }

  private async stopPoller(poller: Poller): Promise<void> {
    this.cancelReconnect(poller);
    const runner = poller.runner;
    if (runner) {
      await Promise.race([
        Promise.resolve(runner.stop()).catch((err: unknown) => {
          console.error("Failed to stop Telegram bot:", errorMessage(err));
        }),
        new Promise((resolve) => setTimeout(resolve, STOP_DRAIN_TIMEOUT_MS)),
      ]);
      poller.runner = null;
    }
    poller.bot = null;
    this.setStatus(poller, { state: "stopped", username: null, since: null, error: null });
  }

  /** Stop every poller, the queue producer, and the bus publisher. Shutdown entry. */
  async close(): Promise<void> {
    for (const poller of this.pollers.values()) {
      poller.desired = false;
      await this.stopPoller(poller);
    }
    await this.queue.close();
    await this.publisher.close();
  }
}
