import "server-only";

import {
  totalTokens,
  trafficTotalsFrom,
  usageRowsFrom,
} from "@/features/analytics/server/trace-source";
import type { Trace } from "@/lib/trace";
import { listTraces, scanTraces } from "@/server/trace";

/**
 * The Overview page's activity read — what the bot has actually been doing.
 *
 * The dashboard's front page used to carry no data at all: a grid of
 * configuration status plus a card whose only content was a link to Analytics.
 * An operator opening it learned whether things were *configured*, never whether
 * they were *working*. This module answers the second question, from the traces,
 * which are the record of every action the bot took.
 *
 * It deliberately reuses the analytics aggregators rather than counting again:
 * "handled", "replied" and "failed" must mean exactly the same thing on the
 * Overview as on the Analytics page, and two implementations of that would not
 * stay in agreement.
 */

/** The rolling window the Overview reports on. */
export const OVERVIEW_WINDOW_HOURS = 24;

/** How many recent actions and failures the Overview lists. */
const RECENT_LIMIT = 8;
const FAILURE_LIMIT = 5;

export interface OverviewActivity {
  /** Start of the reported window (ISO), so the UI can label it honestly. */
  since: string;
  /** Messages the bot opened a trace for — its workload in the window. */
  handled: number;
  /** Those that settled successfully. */
  replied: number;
  /** Those that settled with an error. */
  failed: number;
  /** Distinct people who triggered work. */
  activeUsers: number;
  /** Media the bot described in the window. */
  images: number;
  promptTokens: number;
  completionTokens: number;
  /** Newest traced actions across every feature (headers only). */
  recent: Trace[];
  /** Newest failed traces across every feature (headers only), any age. */
  failures: Trace[];
  /** Failures older than the window are still listed — this says whether any are recent. */
  failuresInWindow: number;
}

/**
 * Traffic, token and failure state for the Overview.
 *
 * The window scan and the two list reads are independent, so they run together.
 * The lists are **not** windowed: an operator wants the last failure whether it
 * happened ten minutes or three days ago — an empty "recent failures" panel that
 * only means "none today" would read as "nothing is wrong".
 */
export async function getOverviewActivity(now: Date = new Date()): Promise<OverviewActivity> {
  // The scan's upper bound is exclusive, and the window means "up to and
  // including this instant" — without the millisecond, work that started in the
  // same tick as the render is invisible until the next one.
  const endUtc = new Date(now.getTime() + 1);
  const startUtc = new Date(now.getTime() - OVERVIEW_WINDOW_HOURS * 60 * 60 * 1000);
  const scope = { startUtc, endUtc };

  const [windowTraces, recentPage, failurePage] = await Promise.all([
    scanTraces(scope),
    listTraces({ limit: RECENT_LIMIT }),
    listTraces({ status: "error", limit: FAILURE_LIMIT }),
  ]);

  const traffic = trafficTotalsFrom(windowTraces, scope);
  const tokens = totalTokens(usageRowsFrom(windowTraces, scope));
  const since = startUtc.toISOString();
  const until = endUtc.toISOString();
  // ISO-8601 UTC strings compare lexically in chronological order, so the window
  // test needs no Date parsing per row — the same trick the store's scan uses.
  const inWindow = (trace: Trace): boolean =>
    trace.startedAt >= since && trace.startedAt < until;

  return {
    since,
    handled: traffic.handled,
    replied: traffic.replied,
    failed: traffic.failed,
    activeUsers: traffic.activeUsers,
    images: traffic.images,
    promptTokens: tokens.processed,
    completionTokens: tokens.generated,
    recent: recentPage.traces,
    failures: failurePage.traces,
    failuresInWindow: failurePage.traces.filter(inWindow).length,
  };
}
