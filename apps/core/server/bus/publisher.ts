import "server-only";

import { openPublisher, type BusPublisher } from "@assistant-hub-swarm/bus";
import { BUS_EVENTS_CHANNEL } from "@assistant-hub-swarm/contracts";

import { getEnv } from "@/server/env";

/**
 * The core's shared bus publisher for service-level events (entity
 * lifecycle like `assistant.deleted`) — the turn consumer keeps its own,
 * boot-owned publisher. Process-global like every cross-bundle singleton
 * here, and env-gated: with no bus configured it resolves null and callers
 * surface the skipped publish audibly (trace event), never silently.
 */

const KEY = Symbol.for("assistant-hub.core.bus.publisher");

export function getBusPublisher(): BusPublisher | null {
  const env = getEnv();
  if (!env.REDIS_URL) return null;
  const g = globalThis as typeof globalThis & { [KEY]?: BusPublisher };
  if (!g[KEY]) g[KEY] = openPublisher(env.REDIS_URL);
  return g[KEY];
}

/**
 * Publish one event onto the cross-app channel through the shared
 * publisher; false when the bus is unconfigured (callers surface it).
 */
export async function publishBusEvent(payload: unknown): Promise<boolean> {
  const publisher = getBusPublisher();
  if (!publisher) return false;
  await publisher.publish(BUS_EVENTS_CHANNEL, payload);
  return true;
}
