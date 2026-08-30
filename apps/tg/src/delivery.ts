import {
  BUS_EVENTS_CHANNEL,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub/contracts";
import {
  openPublisher,
  openSubscriber,
  type BusPublisher,
  type BusSubscription,
} from "@assistant-hub/bus";
import { busTraceClient } from "@assistant-hub/service";

import type { AssistantConnection } from "./connections";
import type { TgOutbound } from "./outbound";
import { publishDelivered } from "./send";
import type { UpdatePublisher } from "./updates";

/**
 * The outbound half of the transport contract: consume the core's
 * reply-delivery events (perform the send, report it back as
 * `message.delivered` — the core mirrors and cross-feeds) and its
 * turn-lifecycle events (render as the Telegram typing indicator). The model
 * never has to remember to deliver its own answer — and typing is never an
 * MCP tool (PLAN.md).
 *
 * Stateless since Phase 7: the `#id` link whitelist arrives ON the event
 * (the core owns the mirror), and the processed-hold release moved to the
 * core's settle handler.
 */

/** What delivery needs from the running bot; the bot manager provides it. */
export type TgSender = Pick<TgOutbound, "sendMessage" | "sendTyping">;

/** Telegram expires a chat action after ~5s; refresh just under that. */
const TYPING_REFRESH_MS = 4_500;

/**
 * Typing runs from `accepted` until `settled` — the transport renders the
 * core's turn lifecycle natively. Keyed per turn so concurrent chats never
 * share a loop.
 */
class TypingLoops {
  private loops = new Map<string, ReturnType<typeof setInterval>>();

  constructor(private readonly senderFor: (assistantId: string | null) => TgSender) {}

  start(key: string, chatId: string, threadId: number | null, assistantId: string | null): void {
    if (this.loops.has(key)) return;
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
 * Subscribe to the bus and act on the events addressed to this transport.
 * Failures are logged, never thrown into the subscriber — one bad delivery
 * must not kill the consumer for every chat.
 */
export async function startDeliveryConsumer(input: {
  redisUrl: string;
  /** Resolve the sender for one assistant's connection, per event. */
  senderFor: (assistantId: string | null) => TgSender;
  /** The connections running right now (the delivered event's roster). */
  running: () => AssistantConnection[];
  /** The transport-update producer (delivered events). */
  updates: UpdatePublisher;
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[tg delivery] ${context}:`, error));
  const typing = new TypingLoops(input.senderFor);
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const traces = busTraceClient("tg", publisher);

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
        // The `#id` whitelist arrives on the event — the core checked its
        // mirror; this side only renders links.
        const linkableMessageIds = (event.linkableSourceMessageIds ?? [])
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id));
        const sent = await input.senderFor(event.assistantId).sendMessage(chatId, event.text, {
          replyToMessageId,
          threadId: event.threadId != null ? Number(event.threadId) : null,
          silent: event.silent,
          linkableMessageIds,
        });
        // Telegram drops a reply target it will not attach and delivers the
        // message anyway (`allow_sending_without_reply`). Said out loud here.
        const replyTargetDropped = replyToMessageId != null && sent.replyToMessageId == null;
        trace.event({
          message: replyTargetDropped
            ? "reply sent — Telegram did not attach the reply target"
            : "reply sent",
          type: "external_call",
          level: replyTargetDropped ? "warn" : "success",
          data: {
            messageId: sent.messageId,
            silent: event.silent,
            linkableMessageIds,
            requestedReplyToMessageId: replyToMessageId,
            replyToMessageId: sent.replyToMessageId,
          },
        });
        // The core's ingest mirrors and cross-feeds off this report.
        await publishDelivered(
          { publisher: input.updates, running: input.running },
          {
            chatId,
            assistantId: event.assistantId,
            messageId: sent.messageId,
            content: event.text,
            replyToMessageId: sent.replyToMessageId,
            threadId: event.threadId != null ? Number(event.threadId) : null,
            silent: event.silent,
          },
        ).catch((error) => {
          onError(`delivered report ${chatId}:${sent.messageId}`, error);
          trace.event({
            message: "delivered report failed (message already delivered)",
            type: "db",
            level: "warn",
            data: { error: error instanceof Error ? error.message : String(error) },
          });
        });
        await trace.succeed({ outputSummary: `delivered ${chatId}:${sent.messageId}` });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
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
