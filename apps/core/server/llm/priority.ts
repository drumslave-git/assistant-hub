import "server-only";

/**
 * Priority gate for the shared LLM endpoint.
 *
 * One endpoint serves everything: live replies, addressing checks, and every
 * background job (history summaries, memory extraction, vision backfill,
 * analytics insights, self-improvement). Local inference servers process
 * requests mostly one at a time, so before this gate a burst of background
 * batches could sit in front of a live reply — and, queuing on the provider's
 * side, background requests burned their whole HTTP timeout waiting in line and
 * died with "Connection timed out" without ever being processed (user decision,
 * 2026-08-01: replies have the highest priority).
 *
 * The gate enforces two rules at dispatch time, in-process:
 *
 * - **Interactive calls run up to {@link MAX_INTERACTIVE_IN_FLIGHT} at a time**,
 *   and queue ahead of all background work when that is full.
 * - **Background calls wait until the endpoint is quiet**: no interactive call
 *   in flight, and at most one background call on the wire at a time. Their
 *   HTTP timeout only starts once dispatched, so a queued job waits patiently
 *   in RAM instead of timing out on the wire.
 *
 * A background call already on the wire cannot be preempted — an interactive
 * call arriving then queues behind it on the provider (bounded by that single
 * request, not by a pile). Constant interactive traffic starves background work
 * by design: jobs are retried on their schedules, replies are not.
 *
 * Kept on a `globalThis` singleton — the same pattern as the trace store and
 * bot manager — so every Next bundle copy shares one gate.
 */

export type LlmPriority = "interactive" | "background";

/**
 * Interactive calls allowed on the wire at once.
 *
 * Not a serialization — the endpoint really does serve in parallel, and forcing
 * one at a time throws that away. It is a cap against the cliff past it.
 * Measured on the live endpoint, 16 requests over four distinct chat histories:
 *
 * | in flight | wall time | p50      |
 * | --------- | --------- | -------- |
 * | 4         | 13996 ms  | 3381 ms  |
 * | 8         | 11398 ms  | 4823 ms  |
 * | 16        | 16698 ms  | 12750 ms |
 *
 * Unbounded is the last row, and it is the worst of both: **longer** overall
 * than a cap of 4 and nearly four times the latency for the person waiting.
 * Sixteen concurrent calls is ordinary traffic, not a stress test — eight group
 * messages arriving together produce exactly that, because each one fires an
 * addressing check and a standing-rule match.
 *
 * 4 over 8 because a person is waiting on one reply, not on the batch: 8 buys
 * ~19% wall time for ~43% more latency on every individual turn.
 */
export const MAX_INTERACTIVE_IN_FLIGHT = 4;

interface PriorityGateStore {
  /** Interactive calls currently on the wire. */
  interactiveInFlight: number;
  /** True while a background call is on the wire (single slot). */
  backgroundBusy: boolean;
  /** Background calls waiting for the endpoint to go quiet, FIFO. */
  waiters: Array<() => void>;
  /**
   * Interactive calls waiting for a slot, FIFO. Kept separate from
   * {@link waiters} so priority is structural: a freed slot always wakes an
   * interactive call first, and background work cannot slip in front of a person
   * waiting on a reply just by having queued earlier.
   */
  interactiveWaiters: Array<() => void>;
}

const STORE_KEY = Symbol.for("assistant-hub-swarm.llm.priority-gate");

function store(): PriorityGateStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: PriorityGateStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = {
      interactiveInFlight: 0,
      backgroundBusy: false,
      waiters: [],
      interactiveWaiters: [],
    };
  }
  return g[STORE_KEY]!;
}

/**
 * Wake whatever may now run: an interactive call if a slot freed, otherwise a
 * background call once the endpoint is fully quiet. Interactive first, always.
 */
function releaseNext(s: PriorityGateStore): void {
  if (s.interactiveInFlight < MAX_INTERACTIVE_IN_FLIGHT) {
    const nextInteractive = s.interactiveWaiters.shift();
    if (nextInteractive) {
      nextInteractive();
      return;
    }
  }
  if (s.interactiveInFlight > 0 || s.backgroundBusy) return;
  s.waiters.shift()?.();
}

/**
 * Run one LLM request under the gate. `run` should cover exactly the provider
 * call — timers and HTTP timeouts inside it then measure the wire, not the
 * queue (the queue wait is visible in traces as the gap before the request
 * event).
 */
export async function withLlmPriority<T>(
  priority: LlmPriority,
  run: () => Promise<T>,
): Promise<T> {
  const s = store();

  if (priority === "interactive") {
    // Wait for a slot rather than piling on. The wait is in RAM, so the caller's
    // HTTP timeout still measures the wire — a queued turn is slow, never a
    // spurious timeout.
    while (s.interactiveInFlight >= MAX_INTERACTIVE_IN_FLIGHT) {
      await new Promise<void>((resolve) => s.interactiveWaiters.push(resolve));
    }
    s.interactiveInFlight += 1;
    try {
      return await run();
    } finally {
      s.interactiveInFlight -= 1;
      releaseNext(s);
    }
  }

  // Background: wait for the quiet endpoint and the single background slot.
  while (s.interactiveInFlight > 0 || s.backgroundBusy) {
    await new Promise<void>((resolve) => s.waiters.push(resolve));
  }
  s.backgroundBusy = true;
  try {
    return await run();
  } finally {
    s.backgroundBusy = false;
    releaseNext(s);
  }
}

/** Test-only: drop gate state so runs stay independent. */
export function resetLlmPriorityGateForTests(): void {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: PriorityGateStore };
  delete g[STORE_KEY];
}
