import "server-only";

import type { RealtimeEvent, RealtimeTopic } from "@/lib/realtime";

/**
 * In-process realtime event hub — a single pub/sub bus shared by every feature.
 *
 * Server code publishes {@link RealtimeEvent}s here (e.g. the trace recorder on a
 * new/settled trace); the SSE Route Handler (`GET /api/events`) subscribes and
 * forwards them to connected dashboard clients. One-way, server→client.
 *
 * Held on a `globalThis` singleton (like the Telegram bot manager) so a single
 * bus instance survives module re-evaluation across Next bundles (Route
 * Handlers, instrumentation) and dev hot-reload. In-process only: this matches
 * the single self-hosted container model. Moving to multiple replicas would
 * require an external fan-out (e.g. Postgres LISTEN/NOTIFY) behind this same API.
 */

type Listener = (event: RealtimeEvent) => void;

interface EventHub {
  listeners: Set<Listener>;
  subscribe(listener: Listener): () => void;
  publish(event: RealtimeEvent): void;
}

const STORE_KEY = Symbol.for("llm-tg-bot.realtime.hub");

function hub(): EventHub {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: EventHub };
  if (!g[STORE_KEY]) {
    const listeners = new Set<Listener>();
    g[STORE_KEY] = {
      listeners,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      publish(event) {
        for (const listener of listeners) {
          // A slow/broken subscriber must not break publishers or siblings.
          try {
            listener(event);
          } catch {
            // ignore
          }
        }
      },
    };
  }
  return g[STORE_KEY]!;
}

/** Subscribe to all events. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  return hub().subscribe(listener);
}

/** Publish an event to all subscribers. Never throws. */
export function publishEvent(
  topic: RealtimeTopic,
  payload: { feature?: string } = {},
): void {
  hub().publish({ topic, feature: payload.feature, at: new Date().toISOString() });
}
