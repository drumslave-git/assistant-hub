import { Redis } from "ioredis";

/**
 * The pub/sub event bus (PLAN.md, "Message flow" / "Events"): every app
 * publishes status/progress/delivery events; consumers subscribe and filter
 * by the payload's `type`. Fire-and-forget fan-out — durability lives in
 * each app's store and the queue, never in the bus.
 *
 * Payloads are JSON. Validation belongs to the consumer (zod schemas from
 * `@assistant-hub-swarm/contracts`) — the bus does not interpret what it carries.
 */

export interface BusPublisher {
  publish(channel: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export function openPublisher(redisUrl: string): BusPublisher {
  const redis = new Redis(redisUrl);
  return {
    async publish(channel: string, payload: unknown): Promise<void> {
      await redis.publish(channel, JSON.stringify(payload));
    },
    async close(): Promise<void> {
      await redis.quit();
    },
  };
}

export interface BusSubscription {
  close(): Promise<void>;
}

/**
 * Subscribe to one channel. `onMessage` receives the parsed JSON payload;
 * a payload that does not parse is dropped via `onError` (a poisoned bus
 * message must never kill a subscriber).
 */
export async function openSubscriber(
  redisUrl: string,
  channel: string,
  onMessage: (payload: unknown) => void,
  onError?: (error: unknown) => void,
): Promise<BusSubscription> {
  // A subscribed ioredis connection can do nothing else — dedicated client.
  const redis = new Redis(redisUrl);
  await redis.subscribe(channel);
  redis.on("message", (incoming: string, raw: string) => {
    if (incoming !== channel) return;
    try {
      onMessage(JSON.parse(raw));
    } catch (error) {
      onError?.(error);
    }
  });
  return {
    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
