import { getAvailability } from "@/features/analytics/server/metrics";
import { availabilityQuerySchema } from "@/features/analytics/server/schema";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Which periods in a range hold data — the period picker's calendar marks.
 *
 * Answered from the calling card's own source, so the calendar never offers a date
 * the card would then render empty.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, availabilityQuerySchema);
  return ok(await getAvailability(query));
});
