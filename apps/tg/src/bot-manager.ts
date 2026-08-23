import { openQueue } from "@assistant-hub/bus";
import { INBOUND_MESSAGES_QUEUE, type InboundMessageEvent } from "@assistant-hub/contracts";
import { run, sequentialize, type RunnerHandle } from "@grammyjs/runner";
import { Bot, HttpError, type Context } from "grammy";

import type { TgDb } from "./db";
import { processIncomingMessage } from "./inbound";
import { createBotOutbound, type TgOutbound } from "./outbound";
import { applyMessageEdit, listEnabledConnections } from "./store";

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
 * Slice A scope: `message` and `edited_message` updates. Reactions and
 * callback queries (the feedback flows, tg-local now) are the next slice —
 * they are not yet in `allowed_updates`, so Telegram holds them back
 * rather than dropping them silently.
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

export class BotManager {
  private pollers = new Map<string, Poller>();
  private queue: ReturnType<typeof openQueue<InboundMessageEvent>>;

  constructor(
    private readonly deps: {
      db: TgDb;
      redisUrl: string;
      onStatusChange?: (status: ConnectionStatus) => void;
    },
  ) {
    this.queue = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, deps.redisUrl);
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
    bot.on("edited_message", (ctx) => this.onEditedMessage(ctx));
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
        fetch: { allowed_updates: ["message", "edited_message"] },
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
      await processIncomingMessage(message, {
        db: this.deps.db,
        assistantId: poller.assistantId,
        identity: {
          botUsername: ctx.me.username,
          // `first_name` is the bot's display name — what people call it.
          botDisplayName: ctx.me.first_name,
        },
        botId: ctx.me.id,
        botToken,
        enqueue: async (event) => {
          await this.queue.add("message.inbound", event);
        },
      });
    } catch (err) {
      console.error(
        `Inbound processing failed for ${ctx.chat.id}:${message.message_id}:`,
        errorMessage(err),
      );
    }
  }

  private async onEditedMessage(ctx: Context): Promise<void> {
    const edited = ctx.editedMessage;
    if (!edited || !ctx.chat) return;
    const content = edited.text ?? edited.caption ?? "";
    if (!content.trim()) return;
    await applyMessageEdit(this.deps.db, {
      chatId: String(edited.chat.id),
      telegramMessageId: edited.message_id,
      content,
      editedAt: new Date((edited.edit_date ?? edited.date) * 1000),
    }).catch((err) => {
      console.error("Failed to mirror edited message:", errorMessage(err));
    });
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

  /** Stop every poller and the queue producer. Shutdown entry. */
  async close(): Promise<void> {
    for (const poller of this.pollers.values()) {
      poller.desired = false;
      await this.stopPoller(poller);
    }
    await this.queue.close();
  }
}
