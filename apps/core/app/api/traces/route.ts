import { getTraceList } from "@/server/trace";
import { defineRoute, ok, parseQuery } from "@/server/http";
import { visibleTraceScope } from "@/server/ownership";
import { traceQuerySchema } from "@/server/trace/schema";

/**
 * Trace list API. Thin handler over the shared Debug service: shared wrappers
 * own query validation and error mapping; the service owns paging and the
 * feature list. Account level since Phase 9 — a user-role account gets only
 * its own assistants' traces (both filters apply, so a foreign assistantId
 * facet simply matches nothing).
 */
export const GET = defineRoute(
  async ({ request, account }) => {
    const query = parseQuery(request, traceQuerySchema);
    const scope = await visibleTraceScope(account);
    return ok(await getTraceList({ ...query, ...scope }));
  },
  { access: "account" },
);
