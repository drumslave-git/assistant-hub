import { getTimezone } from "@/features/settings/server/service";
import { buildTraceBundle } from "@/server/trace";
import { traceBundleFilename } from "@/server/trace/filename";
import { defineRoute, jsonDownload } from "@/server/http";

/**
 * Downloadable JSON log/trace bundle for a single trace (with its events),
 * named by what it holds — feature, action, local start time, id prefix.
 */
export const GET = defineRoute(async ({ params }) => {
  const bundle = await buildTraceBundle(params.id);
  const timeZone = await getTimezone().catch(() => "UTC");
  return jsonDownload(bundle, traceBundleFilename(bundle.traces[0], timeZone));
});
