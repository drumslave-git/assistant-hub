import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openPublisher, openSubscriber } from "./pubsub";
import { openQueue, openWorker } from "./queue";

/** Same image family as the compose `redis` service. */
const REDIS_IMAGE = "redis:7-alpine";

describe("bus", () => {
  let container: StartedTestContainer;
  let redisUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer(REDIS_IMAGE).withExposedPorts(6379).start();
    redisUrl = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("delivers queue jobs exactly once and never retries a failure", async () => {
    const queue = openQueue<{ n: number }>("test-queue", redisUrl);
    const seen: number[] = [];
    let failures = 0;
    const worker = openWorker<{ n: number }>("test-queue", redisUrl, async (job) => {
      if (job.data.n === 2) {
        failures += 1;
        throw new Error("turn failed after acting");
      }
      seen.push(job.data.n);
    });
    try {
      await queue.add("job", { n: 1 });
      await queue.add("job", { n: 2 });
      await queue.add("job", { n: 3 });

      await expect
        .poll(() => seen.length + failures, { timeout: 15_000 })
        .toBe(3);
      // Give a would-be retry time to happen, then prove it never did:
      // attempts: 1 means the failed job stays failed — the turn runner,
      // not the queue, owns re-enqueue.
      await new Promise((r) => setTimeout(r, 500));
      expect(seen.sort()).toEqual([1, 3]);
      expect(failures).toBe(1);
      const failed = await queue.getFailed();
      expect(failed).toHaveLength(1);
      expect(failed[0].data).toEqual({ n: 2 });
      expect(failed[0].attemptsMade).toBe(1);
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  it("fans out pub/sub payloads and survives a poisoned message", async () => {
    const received: unknown[] = [];
    const errors: unknown[] = [];
    const publisher = openPublisher(redisUrl);
    const subscription = await openSubscriber(
      redisUrl,
      "test-channel",
      (payload) => received.push(payload),
      (error) => errors.push(error),
    );
    try {
      await publisher.publish("test-channel", { type: "turn.lifecycle", phase: "accepted" });
      await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
      expect(received[0]).toEqual({ type: "turn.lifecycle", phase: "accepted" });

      // A raw non-JSON publish must reach onError, not kill the subscriber.
      const { Redis } = await import("ioredis");
      const raw = new Redis(redisUrl);
      await raw.publish("test-channel", "not json");
      await raw.quit();
      await expect.poll(() => errors.length, { timeout: 10_000 }).toBe(1);

      await publisher.publish("test-channel", { after: true });
      await expect.poll(() => received.length, { timeout: 10_000 }).toBe(2);
    } finally {
      await subscription.close();
      await publisher.close();
    }
  });
});
