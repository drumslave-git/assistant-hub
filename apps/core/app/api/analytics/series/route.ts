import { getSeries } from "@/features/analytics/server/metrics";
import { seriesQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * One chart card's series, at that card's own period and chat/user filter. The
 * `section` selects which metric; every section answers with the same
 * `{ buckets, series }` shape, so one client card component drives them all.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, seriesQuerySchema);
  return ok(await getSeries(query));
});
