import {
  getAnalyticsJobInfo,
  regenerateAnalyticsInsightsNow,
} from "@/features/analytics/server/scheduler";
import { regenerateSchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseJson } from "@/server/http";

/**
 * Drop a period's stored insights and compute them again.
 *
 * Destructive and billable: every day score covering the period is deleted, along
 * with every roll-up built from it, and each dropped day costs one LLM pass to
 * re-score. This is the deliberate replacement for the job silently re-reading days
 * whose message count had drifted — nothing is rewritten unless it is asked for
 * here.
 */
export const POST = defineRoute(async ({ request }) => {
  const input = await parseJson(request, regenerateSchema);
  await regenerateAnalyticsInsightsNow(input);
  return ok(await getAnalyticsJobInfo());
});
