/**
 * Client-safe shared types for scheduled tasks. Imported by the pure schedule
 * math, the server service/repository, the Route Handlers, and the dashboard UI —
 * so it must stay free of any server-only import.
 */

/** How a task repeats. */
export type ScheduleKind = "once" | "daily" | "weekly";

export const SCHEDULE_KINDS: ScheduleKind[] = ["once", "daily", "weekly"];

/**
 * How many consecutive failed fires a due one-shot gets before it is disabled
 * (kept, badged — never deleted). Client-safe: the dashboard uses it to explain
 * a disabled row.
 */
export const MAX_ONE_SHOT_ATTEMPTS = 5;

/** The schedule portion of a task (what the wall-clock math needs). */
export interface TaskSchedule {
  scheduleKind: ScheduleKind;
  /** Local time of day as `HH:MM` (24-hour) in the task timezone. */
  timeOfDay: string;
  /** Weekdays for `weekly`, 0=Sunday..6=Saturday. */
  weekdays?: number[] | null;
  /** Calendar date for `once` as `YYYY-MM-DD` in the task timezone. */
  runDate?: string | null;
}

/** A scheduled task as returned to clients (no secrets — all fields are safe). */
export interface ScheduledTask {
  id: string;
  chatId: string;
  threadId: number | null;
  createdByUserId: string | null;
  instruction: string;
  /**
   * Background gathered at creation time — what the instruction's references
   * (person, event, joke, topic) actually are, self-contained for a reader with
   * no chat transcript. Null when the instruction needs none.
   */
  context: string | null;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays: number[] | null;
  runDate: string | null;
  enabled: boolean;
  /** Consecutive failed fires of a due one-shot; see {@link MAX_ONE_SHOT_ATTEMPTS}. */
  attempts: number;
  /** The last few delivered message texts (newest first), for wording variation. */
  recentDeliveries: string[];
  /** ISO timestamp of the last firing, or null. */
  lastRunAt: string | null;
  /** ISO timestamp of the next firing, or null when the task will not fire again. */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}
