import {
  BUS_EVENTS_CHANNEL,
  assistantDeletedEventSchema,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub/contracts";
import { openPublisher, openSubscriber, type BusPublisher, type BusSubscription } from "@assistant-hub/bus";

import type { TgDb } from "./db";
import type { TgOutbound } from "./outbound";
import { dashboardRefresh } from "./refresh";
import { appendMessage, filterMirroredMessageIds, markMessageProcessed } from "./store";
import { busTraceClient } from "./trace-client";
import { findMessageRefs } from "./telegram";

/**
 * The outbound half of the source contract: consume the core's
 * reply-delivery events (persist the reply in this store, perform the send)
 * and its turn-lifecycle events (render as the Telegram typing indicator,
 * release the mirror's live-processing hold when the turn settles). The
 * model never has to remember to deliver its own answer — and typing is
 * never an MCP tool (PLAN.md).
 */

/** What delivery needs from the running bot; the bot manager provides it. */
export type TgSender = Pick<TgOutbound, "sendMessage" | "sendTyping">;

/** Telegram expires a chat action after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_500;

/**
 * Typing runs from `accepted` until `settled` — the source renders the
 * core's turn lifecycle natively. Keyed per turn so concurrent chats never
 * share a loop; `progress` refreshes nothing extra (the loop is already
 * ticking) but keeps the contract's phase set honest.
 */
class TypingLoops {
  private loops = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly senderFor: (assistantId: string | null) => TgSender) {}

  start(key: string, chatId: string, threadId: number | null, assistantId: string | null): void {
    if (this.loops.has(key)) return;
    // Resolve per tick: the RIGHT assistant's bot types (a null id — an old
    // publisher — falls back to whichever connection runs), and a poller
    // restart mid-turn never leaves a stale handle. A tick with no running
    // bot is skipped, not thrown — typing is cosmetic.
    const tick = () => {
      try {
        this.senderFor(assistantId).sendTyping(chatId, threadId);
      } catch {
        // No running connection for this assistant right now.
      }
    };
    tick();
    const interval = setInterval(tick, TYPING_REFRESH_MS);
    interval.unref?.();
    this.loops.set(key, interval);
  }

  stop(key: string): void {
    const interval = this.loops.get(key);
    if (!interval) return;
    clearInterval(interval);
    this.loops.delete(key);
  }

  stopAll(): void {
    for (const key of [...this.loops.keys()]) this.stop(key);
  }
}

export interface DeliveryConsumer {
  close(): Promise<void>;
}

/**
 * Subscribe to the bus and act on the events addressed to this source.
 * Payloads are validated per type; anything else on the channel is not ours
 * and is ignored. Failures are logged, never thrown into the subscriber —
 * one bad delivery must not kill the consumer for every chat.
 */
export async function startDeliveryConsumer(input: {
  db: TgDb;
  redisUrl: string;
  /** Resolve the sender for one assistant's connection, per event. */
  senderFor: (assistantId: string | null) => TgSender;
  /**
   * The core deleted an assistant — drop what this app keys on it (the bot
   * manager stops the poller and deletes the connection row).
   */
  onAssistantDeleted?: (assistantId: string) => Promise<void>;
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[tg delivery] ${context}:`, error));
  const typing = new TypingLoops(input.senderFor);
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const traces = busTraceClient(publisher);

  const handle = async (payload: unknown): Promise<void> => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
    if (type === "reply.delivery") {
      const parsed = replyDeliveryEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== "tg") return;
      const event = parsed.data;
      const chatId = parseScopedRef(event.chatRef).id;
      // The delivery half of the turn, on the turn's own correlation — in
      // Debug it lines up right after the core's reply trace.
      const trace = traces.startTrace({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: event.assistantId,
        trigger: { kind: "telegram", actor: chatId, correlationId: event.correlationId },
        inputSummary: event.text,
      });
      try {
        const replyToMessageId =
          event.replyToSourceMessageId != null ? Number(event.replyToSourceMessageId) : null;
        // Which `#<id>` citations really exist here decides what links (the
        // whitelist keeps invented ids as plain text); a failed check drops
        // the links, never the reply.
        const linkableMessageIds = await filterMirroredMessageIds(
          input.db,
          chatId,
          findMessageRefs(event.text),
          event.assistantId,
        ).catch(() => []);
        // Send first, then mirror what was actually delivered — the mirror
        // records reality (v1 order: deliver, then record best-effort).
        const sent = await input.senderFor(event.assistantId).sendMessage(chatId, event.text, {
          replyToMessageId,
          threadId: event.threadId != null ? Number(event.threadId) : null,
          silent: event.silent,
          linkableMessageIds,
        });
        trace.event({
          message: "reply sent",
          type: "external_call",
          level: "success",
          data: { messageId: sent.messageId, silent: event.silent, linkableMessageIds },
        });
        await appendMessage(input.db, {
          chatId,
          assistantId: event.assistantId,
          telegramMessageId: sent.messageId,
          role: "assistant",
          userId: null,
          content: event.text,
          replyToMessageId,
          sentAt: new Date(),
          processed: true,
        }).catch((error) => {
          onError(`mirror of delivered reply ${chatId}:${sent.messageId}`, error);
          trace.event({
            message: "mirror write failed (message already delivered)",
            type: "db",
            level: "warn",
            data: { error: error instanceof Error ? error.message : String(error) },
          });
          return null;
        });
        // The mirror grew a reply — ping the history pages (best-effort).
        void publisher
          .publish(BUS_EVENTS_CHANNEL, dashboardRefresh(["history"]))
          .catch(() => undefined);
        await trace.succeed({ outputSummary: `delivered ${chatId}:${sent.messageId}` });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
      return;
    }
    if (type === "assistant.deleted") {
      const parsed = assistantDeletedEventSchema.safeParse(payload);
      if (!parsed.success || !input.onAssistantDeleted) return;
      await input.onAssistantDeleted(parsed.data.assistantId);
      return;
    }
    if (type === "turn.lifecycle") {
      const parsed = turnLifecycleEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== "tg") return;
      const event = parsed.data;
      const chatId = parseScopedRef(event.chatRef).id;
      const key = `${chatId}:${event.sourceMessageId}`;
      if (event.phase === "settled") {
        typing.stop(key);
        // Release the live-processing hold the mirror took on this message —
        // on every settle, replied or ignored (v1's `finally`).
        await markMessageProcessed(
          input.db,
          chatId,
          Number(event.sourceMessageId),
          event.assistantId ?? null,
        ).catch((error) => onError(`processed release ${key}`, error));
      } else {
        typing.start(
          key,
          chatId,
          event.threadId != null ? Number(event.threadId) : null,
          event.assistantId ?? null,
        );
      }
    }
  };

  const subscription: BusSubscription = await openSubscriber(
    input.redisUrl,
    BUS_EVENTS_CHANNEL,
    (payload) => {
      void handle(payload).catch((error) => onError("event handling", error));
    },
    (error) => onError("bus payload parse", error),
  );

  return {
    async close(): Promise<void> {
      typing.stopAll();
      await subscription.close();
      await publisher.close();
    },
  };
}
