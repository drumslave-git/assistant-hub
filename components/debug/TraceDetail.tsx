import Link from "next/link";
import type { ReactNode } from "react";

import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { formatDuration } from "@/lib/format";
import { debugFilterHref, type Trace } from "@/lib/trace";
import { DownloadButton } from "./DownloadButton";
import { TraceStatusBadge } from "./TraceStatusBadge";
import { TraceTimeline } from "./TraceTimeline";

/** One label/value row in the metadata panel. Omitted entirely when value is empty. */
function Meta({ label, children }: { label: string; children: ReactNode }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs tracking-wide text-faint uppercase">{label}</dt>
      <dd className="text-sm break-words text-foreground">{children}</dd>
    </div>
  );
}

/**
 * Related database row ids grouped by table, for operator drill-down. Each id is
 * a facet like every other id here: it links to the Debug list filtered to
 * everything recorded about that row (`/debug?relatedId=…`).
 */
function RelatedIds({ relatedIds }: { relatedIds: NonNullable<Trace["relatedIds"]> }) {
  const entries = Object.entries(relatedIds).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0) return null;
  return (
    <Meta label="Related rows">
      <ul className="space-y-0.5">
        {entries.map(([table, ids]) => (
          <li key={table} className="font-mono text-xs text-muted">
            {table}:{" "}
            {ids.map((id, index) => (
              <span key={id}>
                {index > 0 ? ", " : null}
                <Link
                  href={debugFilterHref({ relatedId: id })}
                  className="hover:text-primary hover:underline"
                  title={`Show every trace related to ${id}`}
                >
                  {id}
                </Link>
              </span>
            ))}
          </li>
        ))}
      </ul>
    </Meta>
  );
}

/**
 * Shared trace detail view — the single Debug detail layout for every feature:
 * metadata panel, error panel, related rows, ordered event timeline, and a JSON
 * bundle download. Scope/routing is the page's concern; this only renders a trace.
 *
 * Every facet in the header links to the Debug list pre-filtered by it: the
 * status badge, the feature, the trigger, and the correlation (the whole
 * process this trace belongs to) — an operator drills sideways in one click.
 */
export function TraceDetail({ trace }: { trace: Trace }) {
  const duration = formatDuration(trace.startedAt, trace.finishedAt);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{trace.action}</CardTitle>
              <Link
                href={debugFilterHref({ status: trace.status })}
                className="inline-flex hover:opacity-80"
                title={`Show ${trace.status} traces`}
              >
                <TraceStatusBadge status={trace.status} />
              </Link>
            </div>
            <p className="font-mono text-xs text-faint">
              <Link
                href={debugFilterHref({ feature: trace.feature })}
                className="hover:text-primary hover:underline"
                title={`Show ${trace.feature} traces`}
              >
                {trace.feature}
              </Link>
              {" · "}
              {trace.id}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <LiveIndicator topic="traces" />
            <DownloadButton href={`/api/traces/${trace.id}/bundle`} />
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Meta label="Trigger">
              {/* Two independent facets, two links — the actor (a chat id,
                  user id, or job name) filters everything it did, across kinds. */}
              <Link
                href={debugFilterHref({ triggerKind: trace.trigger.kind })}
                className="hover:text-primary hover:underline"
                title={`Show ${trace.trigger.kind}-triggered traces`}
              >
                {trace.trigger.kind}
              </Link>
              {trace.trigger.actor ? (
                <>
                  {" · "}
                  <Link
                    href={debugFilterHref({ actor: trace.trigger.actor })}
                    className="hover:text-primary hover:underline"
                    title={`Show every trace for ${trace.trigger.actor}`}
                  >
                    {trace.trigger.actor}
                  </Link>
                </>
              ) : null}
            </Meta>
            <Meta label="Correlation">
              {trace.trigger.correlationId ? (
                <Link
                  href={debugFilterHref({ correlationId: trace.trigger.correlationId })}
                  className="font-mono text-xs hover:text-primary hover:underline"
                  title="Show every trace of this process"
                >
                  {trace.trigger.correlationId}
                </Link>
              ) : null}
            </Meta>
            <Meta label="Duration">{duration ?? null}</Meta>
            <Meta label="Started">
              <Timestamp iso={trace.startedAt} />
            </Meta>
            <Meta label="Finished">
              {trace.finishedAt ? <Timestamp iso={trace.finishedAt} /> : null}
            </Meta>
            <Meta label="Input">{trace.inputSummary ?? null}</Meta>
            {trace.relatedIds ? <RelatedIds relatedIds={trace.relatedIds} /> : null}
          </dl>
        </CardContent>
      </Card>

      {trace.error ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 p-4">
          <p className="text-xs tracking-wide text-danger uppercase">Error</p>
          <p className="mt-1 text-sm text-foreground">
            {trace.error.code ? (
              <span className="font-mono text-danger">{trace.error.code}: </span>
            ) : null}
            {trace.error.message}
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          <TraceTimeline events={trace.events} startedAt={trace.startedAt} />
        </CardContent>
      </Card>
    </div>
  );
}
