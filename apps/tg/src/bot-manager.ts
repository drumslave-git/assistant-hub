import { openPublisher, type BusPublisher } from "@assistant-hub/bus";
import { BUS_EVENTS_CHANNEL } from "@assistant-hub/contracts";
import { dashboardRefresh } from "@assistant-hub/service";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import type { MessageReactionUpdated } from "@grammyjs/types";
import { Bot, HttpError, type Context } from "grammy";

import type { TransportDesiredState } from "@assistant-hub/contracts";

import type { AssistantConnection } from "./connections";
import { forwardCallbackPress } from "./core-client";
import { presenceEvent, processIncomingMessage } from "./inbound";
import { createBotOutbound, type TgOutbound } from "./outbound";
import { isGroupChat } from "./send";
import { SeenCache, updateEnvelope, type UpdatePublisher } from "./updates";

/**
 * Poller lifecycle for this app's telegram connections — supervision
 * semantics unchanged since the source split (bounded fetch-retry,
 * flat-interval reconnect on transient network failures, edge-triggered
 * logging, bounded stop drain). What each update BECOMES changed with the
 * Phase 7 de-storing: everything is forwarded to the core as
 * transport-update events; nothing is stored here.
 *
 * Updates handled: `message` / `edited_message` /
 * `message_reaction` (feedback triggers — in groups Telegram only delivers
 * them when the bot is an admin) / `callback_query` (menu presses, forwarded
 * synchronously for the toast).
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
  /** The token the current run was started with (reconcile compares it). */
  startedWithToken: string | null;
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

/** Emoji set of one reaction list (custom/paid reactions are not thumbs). */
function emojiSet(reactions: { type: string; emoji?: string }[]): Set<string> {
  const set = new Set<string>();
  for (const reaction of reactions) {
    if (reaction.type === "emoji" && reaction.emoji) set.add(reaction.emoji);
  }
  return set;
}

/**
 * The thumb reaction *added* by this update, or null (reaction removals and
 * other emoji are ignored — feedback is collected only on a fresh 👍/👎).
 * Platform semantics, so the mapping lives with the transport.
 */
export function detectAddedThumb(
  update: Pick<MessageReactionUpdated, "old_reaction" | "new_reaction">,
): "up" | "down" | null {
  const before = emojiSet(update.old_reaction);
  const after = emojiSet(update.new_reaction);
  if (after.has("👍") && !before.has("👍")) return "up";
  if (after.has("👎") && !before.has("👎")) return "down";
  return null;
}

export class BotManager {
  private pollers = new Map<string, Poller>();
  private publisher: BusPublisher;
  private seen = new SeenCache();

  constructor(
    private readonly deps: {
      redisUrl: string;
      updates: UpdatePublisher;
      onStatusChange?: (status: ConnectionStatus) => void;
    },
  ) {
    this.publisher = openPublisher(deps.redisUrl);
  }

  /**
   * Every connection with a live bot account. A stopped or still-connecting
   * poller is not one: it has no identity to put on an event and could not
   * deliver an answer either.
   */
  runningConnections(): AssistantConnection[] {
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

  /**
   * Reconcile the pollers to the core's desired state (boot, and every
   * `transport.config.changed`): start what should run, restart what
   * changed (start is idempotent and always replaces the running bot),
   * stop and drop what is gone or disabled.
   */
  async applyDesiredState(state: TransportDesiredState): Promise<ConnectionStatus[]> {
    const desired = new Map(
      state.connections.map((connection) => [connection.id, connection]),
    );
    for (const [connectionId] of this.pollers) {
      const want = desired.get(connectionId);
      if (!want || !want.enabled) await this.removeConnection(connectionId);
    }
    for (const connection of state.connections) {
      if (!connection.enabled) continue;
      const botToken = connection.config.botToken;
      if (typeof botToken !== "string" || !botToken) {
        console.warn(
          `connection ${connection.id} (assistant ${connection.assistantId}) has no bot token — skipped`,
        );
        continue;
      }
      const running = this.pollers.get(connection.id);
      // Idempotence: an unchanged running connection is left alone; a token
      // change restarts it (tokens are not readable off a running poller, so
      // the desired blob is compared to what this poller was started with).
      if (running?.bot && running.startedWithToken === botToken) continue;
      await this.startConnection({
        connectionId: connection.id,
        assistantId: connection.assistantId,
        botToken,
      });
    }
    return this.statuses();
  }

  statuses(): ConnectionStatus[] {
    return [...this.pollers.values()].map((p) => ({ ...p.status }));
  }

  /**
   * The outbound ops for one assistant's connection. A null assistant means
   * "whichever connection runs". Resolution is per call, so a poller restart
   * never leaves a stale handle behind.
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

  private setStatus(
    poller: Poller,
    status: Omit<ConnectionStatus, "connectionId" | "assistantId">,
  ): void {
    poller.status = {
      connectionId: poller.connectionId,
      assistantId: poller.assistantId,
      ...status,
    };
    this.deps.onStatusChange?.({ ...poller.status });
    // The dashboard's bot card watches `status` — a poller that dies or
    // reconnects must show up without a reload.
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
        startedWithToken: null,
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
    poller.startedWithToken = input.botToken;
    this.cancelReconnect(poller);
    if (poller.bot || poller.runner) await this.stopPoller(poller);

    const bot = new Bot(input.botToken);
    // Per-chat sequential, cross-chat concurrent (v1 decision, 2026-07-20).
    bot.use(sequentialize((ctx) => ctx.chat?.id.toString()));
    bot.on("message", (ctx) => this.onMessage(poller, input.botToken, ctx));
    bot.on("edited_message", (ctx) => this.onEditedMessage(poller, ctx));
    // Feedback collection: 👍/👎 reactions open a menu, presses answer it.
    bot.on("message_reaction", (ctx) => this.onReaction(poller, ctx));
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
    try {
      const result = await processIncomingMessage(message, {
        assistantId: poller.assistantId,
        botId: ctx.me.id,
        botToken,
        running: () => this.runningConnections(),
        seen: this.seen,
      });
      if (result.status === "forwarded") {
        await this.deps.updates.publish(result.event);
      } else if (result.status === "duplicate") {
        // The duplicate receipt still proves THIS bot is in the chat.
        await this.deps.updates.publish(
          presenceEvent({ chatId: String(ctx.chat.id), assistantId: poller.assistantId }),
        );
      }
    } catch (err) {
      console.error(
        `Inbound forwarding failed for ${ctx.chat.id}:${message.message_id}:`,
        errorMessage(err),
      );
    }
  }

  private async onReaction(poller: Poller, ctx: Context): Promise<void> {
    const reaction = ctx.messageReaction;
    if (!reaction) return;
    // Anonymous (channel-identity) reactions carry no user — nobody to ask.
    const user = reaction.user;
    if (!user || user.is_bot) return;
    const thumb = detectAddedThumb(reaction);
    if (!thumb) return;
    const chatId = String(reaction.chat.id);
    // A group reaction reaches every admin bot; forward it once.
    if (
      isGroupChat(chatId) &&
      !this.seen.first(`r:${chatId}:${reaction.message_id}:${user.id}:${thumb}`)
    ) {
      return;
    }
    try {
      await this.deps.updates.publish({
        ...updateEnvelope(`${chatId}:${reaction.message_id}`),
        type: "transport.reaction",
        source: "tg",
        chat: { id: chatId, kind: isGroupChat(chatId) ? "group" : "direct" },
        assistantId: poller.assistantId,
        sourceMessageId: String(reaction.message_id),
        reaction: thumb,
        user: {
          userId: String(user.id),
          username: user.username?.toLowerCase() ?? null,
          firstName: user.first_name ?? null,
          lastName: user.last_name ?? null,
        },
      });
    } catch (err) {
      console.error(
        `Reaction forwarding failed for ${chatId}:${reaction.message_id}:`,
        errorMessage(err),
      );
    }
  }

  private async onCallbackQuery(poller: Poller, bot: Bot, ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    if (!query) return;
    const message = query.message;
    // The menu message is needed to act on it; Telegram omits it for
    // messages that are too old or inaccessible. Answer so the button stops
    // spinning either way.
    if (!message || !query.data) {
      await bot.api.answerCallbackQuery(query.id).catch(() => undefined);
      return;
    }
    const chatId = String(message.chat.id);
    try {
      // Synchronous by design: the platform's spinner wants an answer only
      // the flow's outcome can word (the core owns the flow since Phase 7).
      const { toast } = await forwardCallbackPress({
        source: "tg",
        assistantId: poller.assistantId,
        chat: { id: chatId, kind: isGroupChat(chatId) ? "group" : "direct" },
        user: {
          userId: String(query.from.id),
          username: query.from.username?.toLowerCase() ?? null,
          firstName: query.from.first_name ?? null,
          lastName: query.from.last_name ?? null,
        },
        menuSourceMessageId: String(message.message_id),
        data: query.data,
      });
      await bot.api
        .answerCallbackQuery(query.id, toast ? { text: toast } : undefined)
        .catch(() => undefined);
    } catch (err) {
      console.error(`Callback forwarding failed for query ${query.id}:`, errorMessage(err));
      await bot.api.answerCallbackQuery(query.id).catch(() => undefined);
    }
  }

  private async onEditedMessage(poller: Poller, ctx: Context): Promise<void> {
    const edited = ctx.editedMessage;
    if (!edited || !ctx.chat) return;
    const content = edited.text ?? edited.caption ?? "";
    if (!content.trim()) return;
    const chatId = String(edited.chat.id);
    // A group edit reaches every bot in the chat; forward it once.
    if (
      isGroupChat(chatId) &&
      !this.seen.first(`e:${chatId}:${edited.message_id}:${edited.edit_date ?? edited.date}`)
    ) {
      return;
    }
    await this.deps.updates
      .publish({
        ...updateEnvelope(`${chatId}:${edited.message_id}`),
        type: "transport.edited",
        source: "tg",
        chat: { id: chatId, kind: isGroupChat(chatId) ? "group" : "direct" },
        assistantId: poller.assistantId,
        sourceMessageId: String(edited.message_id),
        content,
        editedAt: new Date((edited.edit_date ?? edited.date) * 1000).toISOString(),
      })
      .catch((err) => {
        console.error("Failed to forward edited message:", errorMessage(err));
      });
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

  /** Stop every poller and the bus publisher. Shutdown entry. */
  async close(): Promise<void> {
    for (const poller of this.pollers.values()) {
      poller.desired = false;
      await this.stopPoller(poller);
    }
    await this.publisher.close();
  }
}
