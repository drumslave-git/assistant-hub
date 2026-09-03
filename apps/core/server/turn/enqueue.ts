import "server-only";

import { openQueue } from "@assistant-hub-swarm/bus";
import { INBOUND_MESSAGES_QUEUE, type InboundMessageEvent } from "@assistant-hub-swarm/contracts";
import type { Queue } from "bullmq";

import { getEnv } from "@/server/env";

/**
 * The producer side of the inbound queue, for turns the core itself opens —
 * since the chat dissolve (Phase 6), posting into a web thread happens in
 * core server code, and the turn still travels through the same queue every
 * source's turns do: one entrance to the pipeline, so ordering (per-chat
 * chains), retry policy and settle bookkeeping never fork by source.
 *
 * Pinned to `globalThis` like every cross-bundle singleton: Route Handlers
 * enqueue from the app bundle while the consumer lives in instrumentation,
 * and each bundle would otherwise open its own connection per hot reload.
 */

const STORE_KEY = Symbol.for("assistant-hub-swarm.core.inbound-queue");

/** The queue producer, or null when the bus is not configured (dev without Redis). */
export function inboundQueue(): Queue<InboundMessageEvent> | null {
  const redisUrl = getEnv().REDIS_URL;
  if (!redisUrl) return null;
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: Queue<InboundMessageEvent> };
  if (!g[STORE_KEY]) g[STORE_KEY] = openQueue<InboundMessageEvent>(INBOUND_MESSAGES_QUEUE, redisUrl);
  return g[STORE_KEY];
}

/** Publish one inbound event as one queue job. */
export async function enqueueInboundEvent(event: InboundMessageEvent): Promise<void> {
  const queue = inboundQueue();
  if (!queue) {
    throw new Error("the message queue is not configured (REDIS_URL) — no turn can be started");
  }
  await queue.add("message.inbound", event);
}
