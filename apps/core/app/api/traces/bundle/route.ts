import { getTimezone } from "@/features/settings/server/service";
import { buildTraceListBundle } from "@/server/trace";
import { traceListBundleFilename } from "@/server/trace/filename";
import { defineRoute, jsonDownload, parseQuery } from "@/server/http";
import { traceQuerySchema } from "@/server/trace/schema";

/**
 * Downloadable JSON log/trace bundle for a filtered set of traces (newest first,
 * capped), each with its events. Powers the Debug page "Download all" export;
 * the filename names the active facets and the local export time.
 */
export const GET = defineRoute(async ({ request }) => {
  const query = parseQuery(request, traceQuerySchema);
  const bundle = await buildTraceListBundle(query);
  const timeZone = await getTimezone().catch(() => "UTC");
  return jsonDownload(bundle, traceListBundleFilename(query, bundle.exportedAt, timeZone));
});
