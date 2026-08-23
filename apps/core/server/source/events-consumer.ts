import "server-only";

import { openSubscriber, type BusSubscription } from "@assistant-hub/bus";
import { BUS_EVENTS_CHANNEL, feedbackRecordedEventSchema } from "@assistant-hub/contracts";

import { handleFeedbackRecorded } from "@/features/self-improvement/server/recorded-consumer";
import { getEnv } from "@/server/env";

/**
 * The core's ear on the cross-app event channel: source apps publish what
 * happened on their side, and the events that feed core features are acted
 * on here. Today that is `feedback.recorded` (the learning half of a
 * completed feedback — see `recorded-consumer.ts`); the SSE bridge for
 * live dashboard refreshes joins on this subscription when it lands.
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
