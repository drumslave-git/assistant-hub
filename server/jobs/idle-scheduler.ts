import "server-only";

import type { JobProgress } from "./progress";

/**
 * Shared in-process idle-debounced job scheduler — the background-job operating
 * model for this app (recorded decision). A single self-hosted container already
 * runs in-process singletons (the Telegram poller, MCP registry, Playwright
 * browser, realtime hub); background jobs run the same way rather than as an
 * external cron, a separate worker, or on-demand only.
 *
 * The trigger is idle-debounced (MVP parity): {@link IdleScheduler.onActivity}
 * is called on every unit of live work (e.g. a handled Telegram message), which
 * (re)arms a debounce timer and aborts any batch currently running. The job body
 * only runs once the system has been quiet for `debounceMs`, so backfill-style
 * work never competes with a live reply for the LLM.
 *
 * This primitive is deliberately job-agnostic — locking, persistence, and
 * tracing belong to the job body (`run`). It owns only the phase machine and the
 * timer. Intended to be wrapped in a `globalThis` singleton per job, like the
 * bot manager, so it survives HMR and there is exactly one per process.
 */

export type JobPhase = "idle" | "scheduled" | "running";

export interface IdleJobStatus {
  phase: JobPhase;
  /** ISO time the last run finished, or null if it has never run. */
  lastRunAt: string | null;
  /** One-line outcome of the last run (e.g. "3 described, 1 failed"). */
  lastSummary: string | null;
  /** Last run's error message, or null when the last run succeeded. */
  lastError: string | null;
  /** ISO time the currently-scheduled run will fire, or null. */
  nextRunAt: string | null;
  /** What the job is doing right now, or null when it is not running. */
  progress: JobProgress | null;
  /**
   * The configured quiet period, so status consumers can *say* when an unarmed
   * job would next run ("90s after the bot's last activity") instead of showing
   * a bare empty next-run.
   */
  debounceMs: number;
}

/** Passed to the job body so it can stop cooperatively when live work resumes. */
export interface JobRunContext {
  /** True once {@link IdleScheduler.onActivity} arrived mid-run — stop soon. */
  isAborted: () => boolean;
  /** Publish live "what it does now" progress; pass null to clear it. */
  reportProgress: (progress: JobProgress | null) => void;
}

export interface IdleJobResult {
  /** One-line human summary recorded as `lastSummary`. */
  summary: string;
}

export interface IdleSchedulerOptions {
  /** Job name, for logs. */
  name: string;
  /** Quiet period before a run fires, in ms. */
  debounceMs: number;
  /** The job body. Should check `ctx.isAborted()` between units of work. */
  run: (ctx: JobRunContext) => Promise<IdleJobResult>;
  /** Notified on every phase/status change (e.g. to publish an SSE event). */
  onStatusChange?: (status: IdleJobStatus) => void;
}

export interface IdleScheduler {
  /** Signal live activity: (re)arm the debounce and abort any running batch. */
  onActivity(): void;
  /** Force a run as soon as possible (e.g. a dashboard "Run now"), bypassing the wait. */
  runNow(): void;
  /** Current status snapshot. Cheap and synchronous — safe for status probes. */
  getStatus(): IdleJobStatus;
  /** Stop the scheduler: clear any pending timer and abort a running batch. */
  stop(): void;
}

/** Create an idle-debounced scheduler. Start it by calling {@link IdleScheduler.onActivity}. */
export function createIdleScheduler(options: IdleSchedulerOptions): IdleScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let phase: JobPhase = "idle";
  let aborted = false;
  let stopped = false;
  let nextRunAt: string | null = null;
  let lastRunAt: string | null = null;
  let lastSummary: string | null = null;
  let lastError: string | null = null;
  let progress: JobProgress | null = null;

  function snapshot(): IdleJobStatus {
    return {
      phase,
      lastRunAt,
      lastSummary,
      lastError,
      nextRunAt,
      progress,
      debounceMs: options.debounceMs,
    };
  }

  function reportProgress(next: JobProgress | null): void {
    progress = next;
    options.onStatusChange?.(snapshot());
  }

  function setPhase(next: JobPhase): void {
    phase = next;
    if (next !== "scheduled") nextRunAt = null;
    options.onStatusChange?.(snapshot());
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function runJob(): Promise<void> {
    if (stopped || phase === "running") return;
    aborted = false;
    setPhase("running");
    try {
      const result = await options.run({
        isAborted: () => aborted || stopped,
        reportProgress,
      });
      lastSummary = result.summary;
      lastError = null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastSummary = lastError;
      console.error(`Job "${options.name}" failed:`, lastError);
    } finally {
      lastRunAt = new Date().toISOString();
      // The run is over — drop any live progress before we notify the settle.
      progress = null;
      // If activity arrived during the run, re-arm; otherwise settle to idle.
      if (!stopped && aborted) {
        schedule();
      } else {
        setPhase("idle");
      }
    }
  }

  function schedule(delayMs = options.debounceMs): void {
    if (stopped) return;
    clearTimer();
    nextRunAt = new Date(Date.now() + delayMs).toISOString();
    setPhase("scheduled");
    timer = setTimeout(() => {
      timer = null;
      void runJob();
    }, delayMs);
  }

  return {
    onActivity() {
      if (stopped) return;
      // Abort a batch in flight so it yields to live work, then re-arm the wait.
      if (phase === "running") aborted = true;
      schedule();
    },
    runNow() {
      if (stopped) return;
      if (phase === "running") return; // already working
      schedule(0);
    },
    getStatus() {
      return snapshot();
    },
    stop() {
      stopped = true;
      aborted = true;
      clearTimer();
      setPhase("idle");
    },
  };
}
