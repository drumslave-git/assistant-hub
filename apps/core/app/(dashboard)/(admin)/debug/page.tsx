import { Database } from "lucide-react";

import { PruneCard, TraceExplorer } from "@/components/debug";
import { EmptyState, PageHeader } from "@/components/ui";
import { getAssistants } from "@/features/assistants/server/service";
import { DEFAULT_TRACE_PAGE_SIZE } from "@/lib/trace";
import { getTraceList, getTraceMonths, type TraceListView } from "@/server/trace";
import { traceQuerySchema } from "@/server/trace/schema";

// Traces are read from the on-disk trace store at request time.
export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Global Debug page — every feature's traces in one filterable, paged list,
 * linking to the shared detail view and JSON bundle export. A genuine store
 * read: a failure surfaces as a real error, not a misleading empty state.
 */
export default async function DebugPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const parsed = traceQuerySchema.safeParse({
    feature: first(sp.feature),
    assistantId: first(sp.assistantId),
    status: first(sp.status),
    correlationId: first(sp.correlationId),
    triggerKind: first(sp.triggerKind),
    actor: first(sp.actor),
    relatedId: first(sp.relatedId),
    flow: first(sp.flow),
    limit: first(sp.limit),
    offset: first(sp.offset),
  });
  const filters = parsed.success ? parsed.data : {};
  // The page always reads one page's worth: an unbounded list is what made this
  // route slow, and `total` still counts the whole match so pagination works.
  // Written as explicit `??` rather than a spread over defaults — zod emits
  // absent optionals as present-but-undefined keys, which a spread would use to
  // overwrite the defaults with `undefined`.
  const query = {
    ...filters,
    limit: filters.limit ?? DEFAULT_TRACE_PAGE_SIZE,
    offset: filters.offset ?? 0,
  };

  let view: TraceListView | null = null;
  let months: string[] = [];
  let storeError: string | null = null;
  try {
    [view, months] = await Promise.all([getTraceList(query), getTraceMonths()]);
  } catch (err) {
    storeError = err instanceof Error ? err.message : "Could not read the trace store";
  }
  // Names for the Assistant column and its dropdown. A store that cannot be
  // read costs the column, never the page: traces are still the point here.
  const assistants = await getAssistants().catch(() => []);

  return (
    <>
      <PageHeader
        title="Debug"
        description="Every traced action across features — inspect decision steps, external calls, LLM usage, and errors, then download a JSON bundle."
      />
      {view ? (
        <div className="space-y-6">
          <TraceExplorer
            view={view}
            query={query}
            basePath="/debug"
            assistants={assistants.map((a) => ({ id: a.id, name: a.name }))}
          />
          <PruneCard months={months} />
        </div>
      ) : (
        <EmptyState
          icon={Database}
          title="Trace store unavailable"
          description={storeError ?? "The trace store could not be read."}
        />
      )}
    </>
  );
}
