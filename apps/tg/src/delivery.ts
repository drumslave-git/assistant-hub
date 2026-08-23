import {
  BUS_EVENTS_CHANNEL,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub/contracts";
import { openSubscriber, type BusSubscription } from "@assistant-hub/bus";

import type { TgDb } from "./db";
import type { TgOutbound } from "./outbound";
import { appendMessage, filterMirroredMessageIds, markMessageProcessed } from "./store";
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

  constructor(private readonly sender: TgSender) {}

  start(key: string, chatId: string, threadId: number | null): void {
    if (this.loops.has(key)) return;
    this.sender.sendTyping(chatId, threadId);
    const interval = setInterval(() => this.sender.sendTyping(chatId, threadId), TYPING_REFRESH_MS);
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
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[tg delivery] ${context}:`, error));
  // Lifecycle events carry no assistant id — with Phase 2's single
  // connection the null resolution is "the bot"; Phase 3 threads the
  // assistant through when concurrent connections arrive.
  const typing = new TypingLoops(input.senderFor(null));

  const handle = async (payload: unknown): Promise<void> => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
    if (type === "reply.delivery") {
      const parsed = replyDeliveryEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== "tg") return;
      const event = parsed.data;
      const chatId = parseScopedRef(event.chatRef).id;
      const replyToMessageId =
        event.replyToSourceMessageId != null ? Number(event.replyToSourceMessageId) : null;
      // Which `#<id>` citations really exist here decides what links (the
      // whitelist keeps invented ids as plain text); a failed check drops
      // the links, never the reply.
      const linkableMessageIds = await filterMirroredMessageIds(
        input.db,
        chatId,
        findMessageRefs(event.text),
      ).catch(() => []);
      // Send first, then mirror what was actually delivered — the mirror
      // records reality (v1 order: deliver, then record best-effort).
      const sent = await input.senderFor(event.assistantId).sendMessage(chatId, event.text, {
        replyToMessageId,
        threadId: event.threadId != null ? Number(event.threadId) : null,
        silent: event.silent,
        linkableMessageIds,
      });
      await appendMessage(input.db, {
        chatId,
        telegramMessageId: sent.messageId,
        role: "assistant",
        userId: null,
        content: event.text,
        replyToMessageId,
        sentAt: new Date(),
        processed: true,
      }).catch((error) => {
        onError(`mirror of delivered reply ${chatId}:${sent.messageId}`, error);
        return null;
      });
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
        await markMessageProcessed(input.db, chatId, Number(event.sourceMessageId)).catch(
          (error) => onError(`processed release ${key}`, error),
        );
      } else {
        typing.start(key, chatId, event.threadId != null ? Number(event.threadId) : null);
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
    },
  };
}
