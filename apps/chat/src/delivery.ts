import {
  BUS_EVENTS_CHANNEL,
  parseScopedRef,
  replyDeliveryEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub/contracts";
import { openPublisher, openSubscriber, type BusPublisher, type BusSubscription } from "@assistant-hub/bus";
import { busTraceClient, dashboardRefresh } from "@assistant-hub/service";

import type { ChatDb } from "./db";
import { appendMessage, getThreadById } from "./store";
import type { ThreadTurns } from "./turns";

/**
 * The outbound half of the source contract: consume the core's
 * reply-delivery events and its turn-lifecycle events for THIS source.
 *
 * "Delivering" to a web thread is storing the reply and telling the
 * dashboard, because the thread is already on screen — there is no platform
 * to hand it to. That is the whole difference from tg's consumer; the trace,
 * the correlation and the refresh ping are identical, which is why the model
 * never has to remember to send its own answer here either.
 *
 * The lifecycle events are this app's typing indicator: they update the
 * running-turn state the thread API serves, and each change pings the
 * dashboard so the browser re-reads and shows what the turn is doing. A
 * settle also pings on its own, so a finished turn shows up even if a
 * delivery ping was missed.
 */

export interface DeliveryConsumer {
  close(): Promise<void>;
}

export async function startDeliveryConsumer(input: {
  db: ChatDb;
  redisUrl: string;
  /** The running-turn state the thread API reads; shared with the API. */
  turns?: ThreadTurns;
  onError?: (context: string, error: unknown) => void;
}): Promise<DeliveryConsumer> {
  const onError =
    input.onError ??
    ((context: string, error: unknown) => console.error(`[chat delivery] ${context}:`, error));
  const publisher: BusPublisher = openPublisher(input.redisUrl);
  const traces = busTraceClient("chat", publisher);

  const pingThreads = () => {
    void publisher
      .publish(BUS_EVENTS_CHANNEL, dashboardRefresh("chat", ["threads"]))
      .catch(() => undefined);
  };

  const handle = async (payload: unknown): Promise<void> => {
    const type =
      payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;

    if (type === "reply.delivery") {
      const parsed = replyDeliveryEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== "chat") return;
      const event = parsed.data;
      const threadId = parseScopedRef(event.chatRef).id;
      // The delivery half of the turn, on the turn's own correlation — in
      // Debug it lines up right after the core's reply trace.
      const trace = traces.startTrace({
        feature: "bot-messaging",
        action: "deliver",
        assistantId: event.assistantId,
        trigger: { kind: "chat", actor: threadId, correlationId: event.correlationId },
        inputSummary: event.text,
      });
      try {
        const thread = await getThreadById(input.db, threadId);
        if (!thread) {
          // The thread was deleted while the turn ran. Nothing to store and
          // nowhere to show it — said out loud rather than swallowed.
          await trace.succeed({ outputSummary: `thread ${threadId} is gone — reply dropped` });
          return;
        }
        const stored = await appendMessage(input.db, {
          threadId,
          role: "assistant",
          content: event.text,
          replyToMessageId:
            event.replyToSourceMessageId != null ? Number(event.replyToSourceMessageId) : null,
        });
        trace.event({
          message: "reply stored in the thread",
          type: "db",
          level: "success",
          data: {
            messageId: stored.id,
            replyToMessageId: stored.replyToMessageId,
            // A web thread has no notification to suppress; the flag is
            // recorded so a silent reply is legible in Debug all the same.
            silent: event.silent,
          },
        });
        pingThreads();
        await trace.succeed({ outputSummary: `delivered ${threadId}:${stored.id}` });
      } catch (error) {
        await trace.fail(error);
        throw error;
      }
      return;
    }

    if (type === "turn.lifecycle") {
      const parsed = turnLifecycleEventSchema.safeParse(payload);
      if (!parsed.success || parsed.data.source !== "chat") return;
      const event = parsed.data;
      const threadId = parseScopedRef(event.chatRef).id;
      const changed = input.turns?.apply(threadId, event) ?? false;
      // Ping on a visible change, and always on settle: the last ping is what
      // clears "thinking…" and shows the finished transcript.
      if (changed || event.phase === "settled") pingThreads();
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
      await subscription.close();
      await publisher.close();
    },
  };
}
