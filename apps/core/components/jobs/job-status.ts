import type { IdleJobStatus } from "@/server/jobs/idle-scheduler";
import type { IntervalJobStatus } from "@/server/jobs/interval-scheduler";

/**
 * Pure job-status helpers, shared by the Client card ({@link ./JobStatusCard})
 * and the server-only jobs registry — which is why they live outside the
 * "use client" module: importing a client module's runtime into the RSC graph
 * is what forced the registry to keep a hand-rolled copy of the activity
 * mapping (now retired). Type-only imports above are erased at compile time,
 * so the `server-only` guards in the scheduler modules do not fire here.
 */

/** What a job is doing right now, as shown on its badge. */
export type JobActivity = "running" | "idle" | "scheduled" | "stopped" | "paused";

/**
 * Map the shared interval scheduler's status onto an activity. A ticking job is
 * running; an armed-but-quiet one is idle; an unarmed one is stopped. A job that
 * is *declining* to do its work reports `paused` instead — that is a policy state
 * the job body owns, not something the ticker can know.
 */
export function intervalJobActivity(status: IntervalJobStatus): JobActivity {
  if (status.ticking) return "running";
  return status.running ? "idle" : "stopped";
}

/**
 * Why an idle-debounced job has no "Next run" right now. These jobs are armed by
 * bot activity, not by the clock: an empty next-run is their normal resting
 * state, which an unexplained "—" turns into a mystery ("is it broken?").
 */
export function idleJobNextRunNote(status: IdleJobStatus): string | null {
  if (status.nextRunAt) return null;
  if (status.phase === "running") return "re-arms after this run settles";
  return `when the bot next goes quiet — ${Math.round(status.debounceMs / 1000)}s after its last activity`;
}

/**
 * Why a daily job has no "Next run": its next occurrence could not be computed,
 * which only happens when the configured run time/timezone is unusable.
 */
export const DAILY_RUN_TIME_INVALID_NOTE =
  "daily run time could not be resolved — check Settings → General";

/** Why the task poller has no "Next run": nothing on the calendar. */
export const NO_UPCOMING_TASKS_NOTE = "no enabled task has an upcoming run";
