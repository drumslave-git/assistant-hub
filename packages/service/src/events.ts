import { randomUUID } from "node:crypto";

import {
  BUS_EVENTS_CHANNEL,
  createSourceTraceRecorder,
  dashboardRefreshEventSchema,
  type DashboardRefreshEvent,
  type SourceId,
  type SourceTraceClient,
} from "@assistant-hub-swarm/contracts";

/**
 * The two things every source app publishes on the bus, parameterized by
 * which source it is — the only difference between one app's wiring and the
 * next's.
 *
 * A `publish` is taken structurally rather than as `@assistant-hub-swarm/bus`'s
 * `BusPublisher` so this package stays out of Redis' way (and tests can hand
 * in an array).
 */
export interface EventPublisher {
  publish(channel: string, payload: unknown): Promise<void>;
}

/**
 * This app's trace client (PLAN "Traces and debug"): actions are recorded
 * locally and delivered to the core as one `trace.recorded` bus event on
 * settle — the core persists them into the single trace store the debug
 * explorer reads. Publishing is best-effort: a bus hiccup can never break the
 * action a trace merely describes; the action's own error handling stays
 * elsewhere.
 *
 * Noise rule carried over from v1: plain chatter that only got mirrored
 * leaves nothing behind. Callers achieve that by simply not settling the
 * recorder for boring outcomes — an unsettled recorder never publishes.
 */
export function busTraceClient(source: SourceId, publisher: EventPublisher): SourceTraceClient {
  return createSourceTraceRecorder({
    source,
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

/**
 * Build one dashboard live-refresh ping. Published wherever an app changes
 * what a dashboard page shows — a mirrored message, a directory row, a poller
 * status, a thread — so the core can bridge it to its SSE layer and no page
 * ever needs a manual reload.
 */
export function dashboardRefresh(source: SourceId, topics: string[]): DashboardRefreshEvent {
  return dashboardRefreshEventSchema.parse({
    v: 1,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: `${source}:refresh`,
    type: "dashboard.refresh",
    source,
    topics,
  });
}
