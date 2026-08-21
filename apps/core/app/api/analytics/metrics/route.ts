import { getMetricTotals } from "@/features/analytics/server/metrics";
import { metricsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * The traffic tiles for one card's filters, aggregated live from the base tables.
 * Chart series come from `../series`; the unfiltered system cards are rendered
 * server-side and have no endpoint.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, metricsQuerySchema);
  return ok(await getMetricTotals(query));
});
