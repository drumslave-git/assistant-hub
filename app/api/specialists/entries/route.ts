import { listEntriesQuerySchema } from "@/features/specialists/server/schema";
import { getEntriesBrowserView } from "@/features/specialists/server/service";
import { defineRoute, ok, parseQuery } from "@/server/http";

/**
 * Specialist entries browser API: the latest stored entries with optional
 * specialist/chat/collection filters, full raw JSON payloads included.
 */
export const GET = defineRoute(async ({ request }) =>
  ok(await getEntriesBrowserView(parseQuery(request, listEntriesQuerySchema))),
);
