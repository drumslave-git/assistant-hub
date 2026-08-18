import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Pagination } from "@/components/ui";
import { DEFAULT_TRACE_PAGE_SIZE } from "@/lib/trace";
import type { TraceListView, TraceQuery } from "@/server/trace";
import { DebugFilters } from "./DebugFilters";
import { DownloadButton } from "./DownloadButton";
import { TraceList } from "./TraceList";

/** Build a query string from the active filters (for the bundle-export link). */
function queryString(query: TraceQuery): string {
  const params = new URLSearchParams();
  if (query.feature) params.set("feature", query.feature);
  if (query.status) params.set("status", query.status);
  if (query.correlationId) params.set("correlationId", query.correlationId);
  if (query.triggerKind) params.set("triggerKind", query.triggerKind);
  if (query.actor) params.set("actor", query.actor);
  if (query.relatedId) params.set("relatedId", query.relatedId);
  if (query.flow) params.set("flow", query.flow);
  return params.toString();
}

/**
 * Shared Debug explorer — filters, live indicator, "download all" bundle export,
 * and one page of the trace list in one reusable block. Every feature's Debug page
 * renders this with an already-fetched {@link TraceListView}; scoped pages hide
 * the feature filter by passing `showFeatureFilter={false}`.
 *
 * The list is paged rather than complete: rendering every trace an installation
 * has ever recorded was the whole cost of opening this page. The export is not —
 * "Download all" still bundles the entire filtered set, page or no page.
 */
export function TraceExplorer({
  view,
  query,
  basePath,
  detailBasePath = "/debug",
  showFeatureFilter = true,
}: {
  view: TraceListView;
  query: TraceQuery;
  /** The Debug page itself — filters navigate here. */
  basePath: string;
  /** Where trace rows link for detail. Shared single detail route by default. */
  detailBasePath?: string;
  showFeatureFilter?: boolean;
}) {
  const { traces, total, features } = view;
  const bundleQs = queryString(query);
  const limit = query.limit ?? DEFAULT_TRACE_PAGE_SIZE;
  const offset = query.offset ?? 0;

  /** A page URL that keeps the active filters — the filters own `offset` reset. */
  const hrefFor = (next: number) => {
    const params = new URLSearchParams(bundleQs);
    if (next > 0) params.set("offset", String(next));
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <DebugFilters
          basePath={basePath}
          features={showFeatureFilter ? features : undefined}
          feature={query.feature}
          status={query.status}
          correlationId={query.correlationId}
          triggerKind={query.triggerKind}
          actor={query.actor}
          relatedId={query.relatedId}
          flow={query.flow}
        />
        <div className="flex items-center gap-2">
          <LiveIndicator topic="traces" />
          <DownloadButton
            href={bundleQs ? `/api/traces/bundle?${bundleQs}` : "/api/traces/bundle"}
            label="Download all"
          />
        </div>
      </div>

      <TraceList traces={traces} basePath={detailBasePath} />

      <Pagination total={total} limit={limit} offset={offset} hrefFor={hrefFor} noun="trace" />

      {total > 0 && total <= limit ? (
        <p className="text-sm text-muted">
          {total} trace{total === 1 ? "" : "s"}
        </p>
      ) : null}
    </div>
  );
}
