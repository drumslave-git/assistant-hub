import "server-only";

import { getDb } from "@/db/drizzle";
import { getBackgroundRuntime, getTimezone } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { createDailyScheduler } from "@/server/jobs/daily-scheduler";
import type { IntervalRunContext } from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import { chatCompletion } from "@/server/llm/client";

import { bucketKeyOfInstant, weekBucketOf } from "../period";

import { GRANULARITIES, type AnalyticsJobInfo, type Granularity } from "../types";
import { regenerateAnalyticsInsights, runAnalyticsInsights } from "./insights";
import { countHoursNeedingInsight, listInsightHours } from "./repository";
import { getInsightScanFloor } from "./watermark";

/**
 * Daily scheduler for the analytics insight job — the shared daily-job model
 * (`server/jobs/daily-scheduler.ts`), plus one extra piece of state: a queued
 * drop-and-regenerate request consumed by the next run.
 *
 * It runs at night because it is expensive (an LLM pass per finished chat-day and
 * per touched period) and nothing live depends on it — the numeric charts are
 * computed live from the base tables, so only the mood/word/topic cards wait for
 * this. Idempotent: an unchanged day/period is skipped, so a re-run costs nothing.
 */

/** A queued drop-and-regenerate, consumed by the next run. */
export interface RegenerateRequest {
  granularity: Granularity;
  bucket: string;
}

/**
 * The pending regenerate lives on its own `globalThis` slot (like the scheduler
 * store itself) so a dev hot-reload cannot drop a queued request.
 */
const REGENERATE_KEY = Symbol.for("llm-tg-bot.analytics.regenerate");

function regenerateSlot(): { pending: RegenerateRequest | null } {
  const g = globalThis as typeof globalThis & {
    [REGENERATE_KEY]?: { pending: RegenerateRequest | null };
  };
  if (!g[REGENERATE_KEY]) g[REGENERATE_KEY] = { pending: null };
  return g[REGENERATE_KEY];
}

/**
 * One insight run with the real collaborators, under the advisory lock. A
 * `regenerate` request drops the period's stored insights first; everything else
 * about the pass — the LLM, the lock, the progress reporting — is identical, which
 * is why regenerate goes through the scheduler rather than running beside it.
 */
async function runJob(ctx?: IntervalRunContext): Promise<string> {
  // Claimed before the run so a failure can't leave it queued to fire again.
  const slot = regenerateSlot();
  const regenerate = slot.pending;
  slot.pending = null;

  const llm = await getBackgroundRuntime().catch(() => null);
  if (!llm) return "LLM not configured";
  const timeZone = await getTimezone().catch(() => "UTC");
  const conn = { baseUrl: llm.baseUrl, apiKey: llm.apiKey, backend: llm.backend };
  const deps = {
    complete: (
      messages: Parameters<typeof chatCompletion>[1]["messages"],
      trace?: Parameters<typeof chatCompletion>[1]["trace"],
    ) =>
      chatCompletion(conn, {
        model: llm.model,
        messages,
        priority: "background",
        ...(trace ? { trace } : {}),
      }),
    timeZone,
    onProgress: ctx?.reportProgress,
  };

  const outcome = await withAdvisoryLock("analytics", () =>
    regenerate ? regenerateAnalyticsInsights(deps, regenerate) : runAnalyticsInsights(deps),
  );
  if (!outcome.ran) return "skipped (locked elsewhere)";
  return outcome.result.summary;
}

const scheduler = createDailyScheduler({
  name: "analytics",
  feature: FEATURES["analytics-insights"],
  runJob,
});

/** Start the daily poller (boot). Idempotent. */
export function startAnalyticsScheduler(): void {
  scheduler.start();
}

/** Stop the poller (shutdown). */
export function stopAnalyticsScheduler(): void {
  scheduler.stop();
}

/** Force an insight run as soon as possible (dashboard "Run now"). */
export function runAnalyticsInsightsNow(): Promise<void> {
  return scheduler.runNow();
}

/**
 * Drop a period's stored insights and compute them again, as soon as possible
 * (dashboard "Regenerate"). Destructive: the rows are gone the moment the run
 * starts, and the re-score costs one LLM pass per dropped day.
 */
export function regenerateAnalyticsInsightsNow(request: RegenerateRequest): Promise<void> {
  regenerateSlot().pending = request;
  return scheduler.runNow();
}

/** The bucket key a scored `YYYY-MM-DD HH` hour belongs to, at a granularity. */
function bucketKeyOfHour(insightHour: string, granularity: Granularity): string {
  const date = insightHour.slice(0, 10);
  switch (granularity) {
    case "hour":
      return insightHour;
    case "day":
      return date;
    case "week":
      return weekBucketOf(date);
    case "month":
      return date.slice(0, 7);
    case "year":
      return date.slice(0, 4);
    case "all":
      return "all";
  }
}

/**
 * The buckets that actually hold scored hours, per granularity — the regenerate
 * picker only ever offers periods there is something to drop. Derived from one scan
 * of the scored hours, newest first.
 */
export async function getRegenerateBuckets(): Promise<Record<Granularity, string[]>> {
  const hours = await listInsightHours(getDb()).catch(() => []);
  const out = {} as Record<Granularity, string[]>;
  for (const g of GRANULARITIES) {
    out[g] = g === "all" ? ["all"] : [...new Set(hours.map((h) => bucketKeyOfHour(h, g)))];
  }
  return out;
}

/** Current job info — reads settings and counts the outstanding backlog. */
export async function getAnalyticsJobInfo(): Promise<AnalyticsJobInfo> {
  const [base, llm] = await Promise.all([
    scheduler.getBaseInfo(),
    getBackgroundRuntime().catch(() => null),
  ]);
  const currentHour = bucketKeyOfInstant(new Date(), "hour", base.timezone);
  const [pendingUnits, regenerateBuckets] = await Promise.all([
    countHoursNeedingInsight(getDb(), {
      timeZone: base.timezone,
      currentHour,
      // Read-only use of the due-scan floor: the count answers the same
      // question the scan does, so it may skip the same proven-scored span.
      floorHour: getInsightScanFloor(base.timezone) ?? undefined,
    }).catch(() => 0),
    getRegenerateBuckets(),
  ]);

  return { ...base, pendingUnits, llmConfigured: llm != null, regenerateBuckets };
}
