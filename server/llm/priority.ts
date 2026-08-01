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
 * - **Interactive calls never wait here.** They go straight to the endpoint;
 *   the provider's own queue is at worst one background request deep.
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

interface PriorityGateStore {
  /** Interactive calls currently on the wire. */
  interactiveInFlight: number;
  /** True while a background call is on the wire (single slot). */
  backgroundBusy: boolean;
  /** Background calls waiting for the endpoint to go quiet, FIFO. */
  waiters: Array<() => void>;
}

const STORE_KEY = Symbol.for("llm-tg-bot.llm.priority-gate");

function store(): PriorityGateStore {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: PriorityGateStore };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = { interactiveInFlight: 0, backgroundBusy: false, waiters: [] };
  }
  return g[STORE_KEY]!;
}

/** Wake the next waiting background call when the endpoint is quiet. */
function releaseNext(s: PriorityGateStore): void {
  if (s.interactiveInFlight > 0 || s.backgroundBusy) return;
  const next = s.waiters.shift();
  next?.();
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
