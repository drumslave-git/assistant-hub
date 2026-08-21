import { getTraceList } from "@/server/trace";
import { defineRoute, ok, parseQuery } from "@/server/http";
import { traceQuerySchema } from "@/server/trace/schema";

/**
 * Trace list API. Thin handler over the shared Debug service: shared wrappers own
 * query validation and error mapping; the service owns paging and the feature list.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, traceQuerySchema);
  return ok(await getTraceList(query));
});
