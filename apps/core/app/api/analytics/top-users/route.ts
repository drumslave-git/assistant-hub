import { getTopUsersCard } from "@/features/analytics/server/metrics";
import { metricsQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/** The most active senders in one period, with the tokens their turns cost. */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, metricsQuerySchema);
  return ok(await getTopUsersCard(query));
});
