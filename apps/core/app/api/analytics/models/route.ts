import { getModels } from "@/features/analytics/server/metrics";
import { metricsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Model performance for one period: every LLM round recorded in the trace files,
 * grouped by model and by what the call was *for*, ordered so the biggest consumer
 * of wall time comes first.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, metricsQuerySchema);
  return ok(await getModels(query));
});
