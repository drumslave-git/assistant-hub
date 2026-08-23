import type { BusPublisher } from "@assistant-hub/bus";
import {
  BUS_EVENTS_CHANNEL,
  createSourceTraceRecorder,
  type SourceTraceClient,
} from "@assistant-hub/contracts";

/**
 * This app's trace client (PLAN "Traces and debug"): actions are recorded
 * locally and delivered to the core as one `trace.recorded` bus event on
 * settle — the core persists them into the single trace store the debug
 * explorer reads. Publishing is best-effort here so a bus hiccup can never
 * break the action a trace merely describes; the action's own error
 * handling stays elsewhere.
 *
 * Noise rule carried over from v1: plain group chatter that only got
 * mirrored leaves nothing behind. Callers achieve that by simply not
 * settling the recorder for boring outcomes — an unsettled recorder never
 * publishes.
 */
export function busTraceClient(publisher: BusPublisher): SourceTraceClient {
  return createSourceTraceRecorder({
    source: "tg",
    publish: async (event) => {
      await publisher
        .publish(BUS_EVENTS_CHANNEL, event)
        .catch((err) =>
          console.error(
            "trace.recorded publish failed:",
            err instanceof Error ? err.message : String(err),
          ),
        );
    },
  });
}
