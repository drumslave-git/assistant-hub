import "server-only";

import type { JobProgress } from "./progress";

/**
 * Shared in-process fixed-interval scheduler — the operating model for
 * *time-based* background jobs (recorded decision, priority 9). It is the sibling
 * of {@link import("./idle-scheduler")}: the idle scheduler *defers* work while
 * the bot is active, but time-based work (a scheduled task firing at 09:00) must
 * run at its wall-clock instant regardless of activity, so it needs a plain
 * ticker instead.
 *
 * Like the idle scheduler, this primitive is deliberately job-agnostic — locking,
 * persistence, and tracing belong to the job body (`run`). It owns only the timer
 * and an overlap guard (a slow tick is never re-entered). Intended to be wrapped
 * in a `globalThis` singleton per job, like the bot manager, so it survives HMR
 * and there is exactly one per process. The timer is `unref`'d so it never keeps
 * the process alive on its own.
 */

export interface IntervalJobStatus {
  /** Whether the ticker is currently armed. */
  running: boolean;
  /** Whether a tick is executing right now. */
  ticking: boolean;
  /** ISO time the last tick finished, or null if it has never run. */
  lastTickAt: string | null;
  /** One-line outcome of the last tick (e.g. "2 fired"). */
  lastSummary: string | null;
  /** Last tick's error message, or null when the last tick succeeded. */
  lastError: string | null;
  /** What the job is doing right now, or null when no tick is executing. */
  progress: JobProgress | null;
}

export interface IntervalJobResult {
  /** One-line human summary recorded as `lastSummary`. */
  summary: string;
}

/** Passed to the job body so it can publish live progress. */
export interface IntervalRunContext {
  /** Publish live "what it does now" progress; pass null to clear it. */
  reportProgress: (progress: JobProgress | null) => void;
}

export interface IntervalSchedulerOptions {
  /** Job name, for logs. */
  name: string;
  /** Tick period in ms. */
  tickMs: number;
  /** The job body, invoked once per tick. Overlapping ticks are skipped. */
  run: (ctx: IntervalRunContext) => Promise<IntervalJobResult>;
  /** Notified on every status change (e.g. to publish an SSE event). */
  onStatusChange?: (status: IntervalJobStatus) => void;
}

export interface IntervalScheduler {
  /** Arm the ticker (idempotent). */
  start(): void;
  /** Stop the ticker. A tick already in flight finishes; no new ones start. */
  stop(): void;
  /** Run one tick immediately (dashboard "Run now" / tests). Skipped if one is in flight. */
  runNow(): Promise<void>;
  /** Current status snapshot. Cheap and synchronous — safe for status probes. */
  getStatus(): IntervalJobStatus;
}

/** Create a fixed-interval scheduler. Arm it with {@link IntervalScheduler.start}. */
export function createIntervalScheduler(options: IntervalSchedulerOptions): IntervalScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let lastTickAt: string | null = null;
  let lastSummary: string | null = null;
  let lastError: string | null = null;
  let progress: JobProgress | null = null;

  function snapshot(): IntervalJobStatus {
    return { running: timer !== null, ticking, lastTickAt, lastSummary, lastError, progress };
  }

  function notify(): void {
    options.onStatusChange?.(snapshot());
  }

  function reportProgress(next: JobProgress | null): void {
    progress = next;
    notify();
  }

  async function tick(): Promise<void> {
    if (ticking) return; // never re-enter a slow tick
    ticking = true;
    notify();
    try {
      const result = await options.run({ reportProgress });
      lastSummary = result.summary;
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastSummary = lastError;
      console.error(`Job "${options.name}" tick failed:`, lastError);
    } finally {
      lastTickAt = new Date().toISOString();
      // The tick is over — drop any live progress before we notify the settle.
      progress = null;
      ticking = false;
      notify();
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), options.tickMs);
      if (typeof timer.unref === "function") timer.unref();
      notify();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        notify();
      }
    },
    runNow() {
      return tick();
    },
    getStatus() {
      return snapshot();
    },
  };
}
