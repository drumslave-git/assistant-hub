import "server-only";

import { bucketKeyOfInstant } from "../period";

/**
 * In-process lower bound (a watermark) for the insight due-scan.
 *
 * The due-scan asks "which (chat, hour) pairs have messages but no stored
 * insight?" — naively answered by re-grouping the entire mirror through a
 * computed timezone expression on every nightly run *and* every jobs-dashboard
 * read. But new owed hours only ever appear near the present: once a scan has
 * proven that every hour below some point is scored, no later scan can find new
 * work there — with two exceptions, both handled explicitly:
 *
 * - Telegram can deliver a backlogged update up to ~24 hours old (its
 *   `getUpdates` retention), landing a fresh row in an old hour. The floor
 *   therefore never advances closer than {@link BACKLOG_SAFETY_HOURS} behind
 *   "now".
 * - A history CSV import writes, and a regenerate un-scores, arbitrarily old
 *   hours. Both call {@link resetInsightScanFloor}, so the next scan is
 *   unbounded and sees them.
 *
 * The floor is deliberately process-local (a `globalThis` slot, like the
 * schedulers): a boot starts cold with one unbounded scan — exactly the
 * pre-floor behavior — and the app runs as a single process, so there is no
 * second process whose scans could advance past work this one created.
 */

interface FloorState {
  /**
   * `YYYY-MM-DD HH`. Every hour strictly below this is known fully scored;
   * the floor hour itself may still be owed (scoring it can fail), so scans
   * must treat the bound as inclusive.
   */
  hour: string;
  /** The timezone the hour keys were computed in; a change invalidates them. */
  timeZone: string;
}

const STORE_KEY = Symbol.for("llm-tg-bot.analytics.insight-scan-floor");

function slot(): { current: FloorState | null } {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: { current: FloorState | null } };
  if (!g[STORE_KEY]) g[STORE_KEY] = { current: null };
  return g[STORE_KEY];
}

/** Telegram's backlog-delivery retention (~24 h), generously rounded up. */
const BACKLOG_SAFETY_HOURS = 25;

/**
 * The scan floor for a due-scan in this timezone, or null when cold (first scan
 * after boot, after a reset, or after a timezone change) — a cold floor means an
 * unbounded scan.
 */
export function getInsightScanFloor(timeZone: string): string | null {
  const state = slot().current;
  return state && state.timeZone === timeZone ? state.hour : null;
}

/**
 * Record what a completed due-scan proved: every hour below its oldest pending
 * find (or below the scan's `currentHour`, when nothing was pending) is scored.
 * The stored floor is additionally clamped to {@link BACKLOG_SAFETY_HOURS}
 * behind `now`, so a late-delivered Telegram update can never land below it.
 */
export function advanceInsightScanFloor(params: {
  oldestPendingHour: string | null;
  currentHour: string;
  now: Date;
  timeZone: string;
}): void {
  const proven = params.oldestPendingHour ?? params.currentHour;
  const safety = bucketKeyOfInstant(
    new Date(params.now.getTime() - BACKLOG_SAFETY_HOURS * 3_600_000),
    "hour",
    params.timeZone,
  );
  // Hour keys are fixed-width, so lexical order is chronological order.
  slot().current = { hour: proven < safety ? proven : safety, timeZone: params.timeZone };
}

/**
 * Forget the floor — the next scan is unbounded. Required whenever rows may have
 * appeared, or insights disappeared, below it: a history CSV import, an insight
 * regenerate.
 */
export function resetInsightScanFloor(): void {
  slot().current = null;
}
