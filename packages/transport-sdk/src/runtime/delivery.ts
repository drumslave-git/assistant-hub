import {
  BUS_EVENTS_CHANNEL,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub-swarm/contracts";
import { openPublisher, openSubscriber, type BusPublisher, type BusSubscription } from "@assistant-hub-swarm/bus";
import { busTraceClient } from "@assistant-hub-swarm/service";

import { sendChatMessage, type SendContext } from "./send";
import type { PlatformConnection, TransportDescriptor } from "./types";

/**
 * The outbound half of the contract: consume the core's reply-delivery events
 * (perform the send, report it back — the core mirrors and cross-feeds) and
 * its turn-lifecycle events (render as the platform's typing indicator).
 *
 * The model never has to remember to deliver its own answer, and typing is
 * never a tool. Both were written identically in every transport.
 */

export interface DeliveryConsumer {
  close(): Promise<void>;
}

/**
 * Typing runs from `accepted` until `settled`. Keyed per turn so concurrent
 * chats never share a loop, and unref'd so it never holds the process open.
 */
class TypingLoops {
  private loops = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly connectionFor: (assistantId: string | null) => PlatformConnection,
    private readonly refreshMs: number,
  ) {}

  start(key: string, chatId: string, threadId: string | null, assistantId: string | null): void {
    if (this.loops.has(key)) return;
    const tick = () => {
      try {
        this.connectionFor(assistantId).sendTyping?.(chatId, threadId);
      } catch {
        // No running connection for this assistant right now.
      }
    };
    tick();
    const interval = setInterval(tick, this.refreshMs);
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

export async function startDeliveryConsumer(input: {
  redisUrl: string;
  descriptor: TransportDescriptor;
  send: SendContext;
  /** Whether a chat is direct; the core's refs do not carry the kind. */
  isDirect: (chatId: string) => Promise<boolean>;
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const source = input.descriptor.id;
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[${source} delivery] ${context}:`, error));
  const typing = new TypingLoops(input.send.connectionFor, input.descriptor.typingRefreshMs);
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const traces = busTraceClient(source, publisher);

  const handle = async (payload: unknown): Promise<void> => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;

    if (type === "reply.delivery") {
      const parsed = replyDeliveryEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== source) return;
      const event = parsed.data;
      const chatId = parseScopedRef(event.chatRef).id;
      // The delivery half of the turn, on the turn's own correlation — in
      // Debug it lines up right after the core's reply trace.
      const trace = traces.startTrace({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: event.assistantId,
        trigger: { kind: "transport", actor: event.chatRef, correlationId: event.correlationId },
        inputSummary: event.text,
      });
      try {
        const direct = await input.isDirect(chatId).catch(() => false);
        const sent = await sendChatMessage(
          {
            ...input.send,
            onReportFailure: (sourceMessageId, error) => {
              onError(`delivered report ${chatId}:${sourceMessageId}`, error);
              trace.event({
                message: "delivered report failed (message already delivered)",
                type: "db",
                level: "warn",
                data: {
                  sourceMessageId,
                  error: error instanceof Error ? error.message : String(error),
                },
              });
            },
          },
          {
            chatId,
            assistantId: event.assistantId,
            text: event.text,
            direct,
            replyToSourceMessageId: event.replyToSourceMessageId ?? null,
            threadId: event.threadId ?? null,
            silent: event.silent,
            linkableSourceMessageIds: event.linkableSourceMessageIds ?? [],
          },
        );
        // A platform that cannot attach the reply target delivers the message
        // anyway rather than losing it; said out loud here.
        const replyTargetDropped =
          event.replyToSourceMessageId != null && sent.replyToSourceMessageId == null;
        const parts =
          sent.sourceMessageIds.length > 1 ? ` as ${sent.sourceMessageIds.length} messages` : "";
        trace.event({
          message: replyTargetDropped
            ? `reply sent${parts} — the platform did not attach the reply target`
            : `reply sent${parts}`,
          type: "external_call",
          level: replyTargetDropped ? "warn" : "success",
          data: {
            sourceMessageId: sent.sourceMessageId,
            sourceMessageIds: sent.sourceMessageIds,
            silent: event.silent,
            requestedReplyToSourceMessageId: event.replyToSourceMessageId ?? null,
            replyToSourceMessageId: sent.replyToSourceMessageId,
          },
        });
        await trace.succeed({
          outputSummary: `delivered ${chatId}:${sent.sourceMessageIds.join(",")}`,
        });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
      return;
    }

    if (type === "turn.lifecycle") {
      const parsed = turnLifecycleEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== source) return;
      const event = parsed.data;
      const chatId = parseScopedRef(event.chatRef).id;
      const key = `${chatId}:${event.sourceMessageId}`;
      if (event.phase === "settled") {
        typing.stop(key);
      } else {
        typing.start(key, chatId, event.threadId ?? null, event.assistantId ?? null);
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
