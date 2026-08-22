import { Queue, Worker, type ConnectionOptions, type Job } from "bullmq";

/**
 * BullMQ plumbing for the inbound-message queue (PLAN.md, "Message flow":
 * one job per inbound message).
 *
 * `attempts: 1` is a decision, not a default (user decision, 2026-08-22,
 * confirming PLAN's turn-failure rule): the queue NEVER retries a job on
 * its own. A failed turn retries only if it performed no actions yet, and
 * only the turn runner can know that — it re-enqueues explicitly after
 * checking the actions-started marker. Queue-level retries would re-run
 * turns that already sent a reply or executed a tool.
 */

function connection(redisUrl: string): ConnectionOptions {
  // BullMQ requires maxRetriesPerRequest: null on its blocking connections.
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/** A producer handle for one queue. Close it on shutdown. */
export function openQueue<Payload>(name: string, redisUrl: string): Queue<Payload> {
  return new Queue<Payload>(name, {
    connection: connection(redisUrl),
    defaultJobOptions: {
      attempts: 1,
      // Completed jobs are history the trace store already keeps — cap what
      // Redis retains. Failed jobs are kept longer for operator inspection.
      removeOnComplete: { count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  });
}

/**
 * A consumer for one queue. `handler` failures fail the job (no retry — see
 * above); the caller decides what failure means. Close it on shutdown.
 */
export function openWorker<Payload>(
  name: string,
  redisUrl: string,
  handler: (job: Job<Payload>) => Promise<void>,
  options?: { concurrency?: number },
): Worker<Payload> {
  return new Worker<Payload>(name, handler, {
    connection: connection(redisUrl),
    concurrency: options?.concurrency ?? 1,
  });
}
