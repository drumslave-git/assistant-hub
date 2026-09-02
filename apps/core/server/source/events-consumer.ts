import "server-only";

import { openSubscriber, type BusSubscription } from "@assistant-hub-swarm/bus";
import {
  BUS_EVENTS_CHANNEL,
  dashboardRefreshEventSchema,
  feedbackRecordedEventSchema,
  parseScopedRef,
  replyDeliveryEventSchema,
  traceRecordedEventSchema,
  turnLifecycleEventSchema,
} from "@assistant-hub-swarm/contracts";

import { releaseHold } from "@/server/ingest/consumer";

import { handleFeedbackRecorded } from "@/features/self-improvement/server/recorded-consumer";
import {
  handleChatReplyDelivery,
  handleChatTurnLifecycle,
} from "@/features/web-chat/server/delivery";
import { REALTIME_TOPICS, type RealtimeTopic } from "@/lib/realtime";
import { getEnv } from "@/server/env";
import { publishEvent } from "@/server/realtime/hub";
import { ingestSourceTrace } from "@/server/trace/ingest";

/**
 * The core's ear on the cross-app event channel: source apps publish what
 * happened on their side, and the events that feed core features are acted
 * on here — `feedback.recorded` (the learning half of a completed feedback,
 * see `recorded-consumer.ts`), `dashboard.refresh` (the SSE bridge), and
 * `trace.recorded` (the unified trace store's ingest half).
 *
 * Reply-delivery and turn-lifecycle events are each source's to consume, and
 * since the chat dissolve (Phase 6) the core IS the web chat's source side:
 * the pipeline still publishes every turn's events to the bus, tg's app
 * consumes its own, and the web chat's are consumed right here — the reply
 * stored in the thread, the lifecycle rendered as live progress. Other
 * sources' stay ignored by type.
 */

export interface SourceEventsConsumer {
  close(): Promise<void>;
}

export async function startSourceEventsConsumer(input: {
  redisUrl: string;
}): Promise<SourceEventsConsumer> {
  const subscription: BusSubscription = await openSubscriber(
    input.redisUrl,
    BUS_EVENTS_CHANNEL,
    (payload) => {
      const type =
        payload && typeof payload === "object" ? (payload as { type?: unknown }).type : undefined;
      if (type === "dashboard.refresh") {
        // The SSE bridge: a source changed what a dashboard page shows —
        // ping the in-process topics its watchers subscribe to.
        const refresh = dashboardRefreshEventSchema.safeParse(payload);
        if (refresh.success) {
          // Only topics this dashboard actually serves — a stray name from
          // the wire pings nothing rather than a phantom channel.
          for (const topic of refresh.data.topics) {
            if ((REALTIME_TOPICS as readonly string[]).includes(topic)) {
              publishEvent(topic as RealtimeTopic);
            }
          }
        }
        return;
      }
      if (type === "reply.delivery") {
        const parsed = replyDeliveryEventSchema.safeParse(payload);
        if (!parsed.success || parsed.data.source !== "chat") return;
        // Detached: one bad delivery must not kill the subscriber; the
        // failure lands in its own deliver trace.
        void handleChatReplyDelivery(parsed.data).catch((err) => {
          console.error(
            "web-chat reply delivery failed:",
            err instanceof Error ? err.message : String(err),
          );
        });
        return;
      }
      if (type === "turn.lifecycle") {
        const parsed = turnLifecycleEventSchema.safeParse(payload);
        if (!parsed.success) return;
        if (parsed.data.source === "chat") {
          handleChatTurnLifecycle(parsed.data);
          return;
        }
        // A transport turn settled: release the mirror row's live-processing
        // hold (the transport keeps only the typing rendering; the hold moved
        // in with the store — Phase 7).
        if (parsed.data.phase === "settled") {
          const event = parsed.data;
          void releaseHold(
            event.source,
            parseScopedRef(event.chatRef).id,
            event.sourceMessageId,
            event.assistantId ?? null,
          ).catch((err) => {
            console.error(
              "processed-hold release failed:",
              err instanceof Error ? err.message : String(err),
            );
          });
        }
        return;
      }
      if (type === "trace.recorded") {
        // The unified trace store: a source app settled an action and hands
        // its whole trace over for persistence (PLAN "Traces and debug").
        const recorded = traceRecordedEventSchema.safeParse(payload);
        if (!recorded.success) {
          console.error("Malformed trace.recorded event ignored:", recorded.error.message);
          return;
        }
        ingestSourceTrace(recorded.data.trace);
        return;
      }
      if (type !== "feedback.recorded") return;
      const parsed = feedbackRecordedEventSchema.safeParse(payload);
      if (!parsed.success) {
        console.error("Malformed feedback.recorded event ignored:", parsed.error.message);
        return;
      }
      // Detached like every learning step: the source already stored the
      // answer, and one bad event must not kill the subscriber.
      void handleFeedbackRecorded(parsed.data).catch((err) => {
        console.error(
          "feedback.recorded handling failed:",
          err instanceof Error ? err.message : String(err),
        );
      });
    },
    (error) => console.error("Bus payload parse failed:", error),
  );
  return { close: () => subscription.close() };
}

/** Env-gated starter for boot: runs only when the bus is configured. */
export async function startSourceEventsConsumerFromEnv(): Promise<SourceEventsConsumer | null> {
  const env = getEnv();
  if (!env.REDIS_URL) return null;
  return startSourceEventsConsumer({ redisUrl: env.REDIS_URL });
}
