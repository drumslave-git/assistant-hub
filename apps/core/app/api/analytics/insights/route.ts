import { getPeriodInsightCard } from "@/features/analytics/server/metrics";
import { insightsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * The stored LLM-derived roll-up (mood + word of the period + top topic) for one
 * chat's selected period. Returns `null` when that period has not been rolled up
 * yet — insights only ever cover finished hours.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, insightsQuerySchema);
  return ok(await getPeriodInsightCard(query));
});
