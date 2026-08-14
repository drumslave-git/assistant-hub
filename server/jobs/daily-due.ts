import { parseTimeOfDay, zonedDate, zonedWallClockToUtc } from "@/features/tasks/schedule";

/**
 * Wall-clock due-math shared by the daily background jobs (self-improvement,
 * history summarization), which run "at HH:MM in the operator's timezone" on a
 * fixed-interval ticker rather than on a cron.
 *
 * The ticker fires every minute and asks: has today's run instant passed, and have
 * we not run since it? That question is the whole contract — it makes a run
 * idempotent across restarts (a process that comes back up after the hour still
 * runs the day's job once) and immune to drift (no accumulating "every 24h" error).
 *
 * Pure — no DB, no timers — so both schedulers can share it and it is directly
 * unit-testable.
 */

/** Today's run instant (UTC) for a local `HH:MM` in `timeZone`, or null if unparseable. */
export function todaysRunInstant(timeOfDay: string, now: Date, timeZone: string): Date | null {
  const time = parseTimeOfDay(timeOfDay);
  if (!time) return null;
  const today = zonedDate(now, timeZone);
  return zonedWallClockToUtc(today.year, today.month, today.day, time.hour, time.minute, timeZone);
}

/**
 * Whether the daily run is owed: today's run instant has passed and no run has
 * happened at or after it. An unparseable time is never due (rather than
 * defaulting to "run constantly").
 */
export function isDailyRunDue(input: {
  timeOfDay: string;
  now: Date;
  timeZone: string;
  lastRunAt: Date | null;
}): boolean {
  const target = todaysRunInstant(input.timeOfDay, input.now, input.timeZone);
  if (!target) return false;
  if (input.now.getTime() < target.getTime()) return false;
  return input.lastRunAt === null || input.lastRunAt.getTime() < target.getTime();
}
