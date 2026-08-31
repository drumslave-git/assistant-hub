import { getTimezone } from "@/features/settings/server/service";
import { buildTraceBundle } from "@/server/trace";
import { traceBundleFilename } from "@/server/trace/filename";
import { defineRoute, jsonDownload } from "@/server/http";
import { requireTraceVisible } from "@/server/ownership";

/**
 * Downloadable JSON log/trace bundle for a single trace (with its events),
 * named by what it holds — feature, action, local start time, id prefix.
 * Ownership-gated like the detail view (Phase 9).
 */
export const GET = defineRoute(
  async ({ params, account }) => {
    const bundle = await buildTraceBundle(params.id);
    await requireTraceVisible(account, bundle.traces[0]);
    const timeZone = await getTimezone().catch(() => "UTC");
    return jsonDownload(bundle, traceBundleFilename(bundle.traces[0], timeZone));
  },
  { access: "account" },
);
