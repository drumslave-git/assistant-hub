import "server-only";

import { openSubscriber, type BusSubscription } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  dashboardRefreshEventSchema,
  feedbackRecordedEventSchema,
  traceRecordedEventSchema,
} from "@assistant-hub/contracts";

import { handleFeedbackRecorded } from "@/features/self-improvement/server/recorded-consumer";
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
 * Reply-delivery and turn-lifecycle events on the same channel are the
 * sources' to consume — ignored here by type.
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
