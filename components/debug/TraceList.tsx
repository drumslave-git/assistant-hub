import Link from "next/link";
import { Bug, ChevronRight } from "lucide-react";

import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import { formatDuration } from "@/lib/format";
import { debugFilterHref, type Trace } from "@/lib/trace";
import { TraceStatusBadge } from "./TraceStatusBadge";

/**
 * Shared trace list — a dense, scannable table of trace headers linking to the
 * detail view. Used by every feature's Debug page (scope by pre-filtering the
 * `traces` passed in). Events are omitted here; the detail view loads them.
 *
 * Facet cells (status, feature, trigger) link to the Debug list pre-filtered by
 * that facet — sitting above the row's stretched link (`relative z-10`), so a
 * facet click filters and any other click opens the trace.
 */
export function TraceList({
  traces,
  basePath = "/debug",
}: {
  traces: Trace[];
  /** Detail links are `${basePath}/${trace.id}`. */
  basePath?: string;
}) {
  if (traces.length === 0) {
    return (
      <EmptyState
        icon={Bug}
        title="No traces yet"
        description="Traced actions appear here as the bot and dashboard record them."
      />
    );
  }

  return (
    <Table minWidth={680}>
      <TableHead>
        <TableRow header>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Feature</TableHeaderCell>
          <TableHeaderCell>Action</TableHeaderCell>
          <TableHeaderCell>Trigger</TableHeaderCell>
          <TableHeaderCell>Started</TableHeaderCell>
          <TableHeaderCell align="right">Duration</TableHeaderCell>
          <TableHeaderCell className="w-8 px-2" aria-hidden />
        </TableRow>
      </TableHead>
      <TableBody>
        {traces.map((trace) => {
          const duration = formatDuration(trace.startedAt, trace.finishedAt);
          return (
            <TableRow key={trace.id} interactive>
              <TableCell>
                <Link
                  href={debugFilterHref({ status: trace.status })}
                  className="relative z-10 inline-flex hover:opacity-80"
                  title={`Show ${trace.status} traces`}
                >
                  <TraceStatusBadge status={trace.status} />
                </Link>
              </TableCell>
              <TableCell>
                <Link
                  href={debugFilterHref({ feature: trace.feature })}
                  className="relative z-10 text-muted hover:text-primary hover:underline"
                  title={`Show ${trace.feature} traces`}
                >
                  {trace.feature}
                </Link>
              </TableCell>
              <TableCell>
                {/* Stretched link: covers the whole row so any cell click opens the trace. */}
                <Link
                  href={`${basePath}/${trace.id}`}
                  className="font-medium text-foreground group-hover:text-primary after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none"
                >
                  {trace.action}
                </Link>
                {trace.inputSummary ? (
                  <p className="mt-0.5 max-w-xs truncate text-xs text-faint">
                    {trace.inputSummary}
                  </p>
                ) : null}
              </TableCell>
              <TableCell>
                <Link
                  href={debugFilterHref({
                    triggerKind: trace.trigger.kind,
                    actor: trace.trigger.actor,
                  })}
                  className="relative z-10 text-muted hover:text-primary hover:underline"
                  title="Show traces with this trigger"
                >
                  {trace.trigger.kind}
                  {trace.trigger.actor ? (
                    <span className="text-faint"> · {trace.trigger.actor}</span>
                  ) : null}
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap text-muted">
                <Timestamp iso={trace.startedAt} />
              </TableCell>
              <TableCell align="right" className="whitespace-nowrap text-muted">
                {duration ?? "—"}
              </TableCell>
              <TableCell valign="middle" className="px-2 text-faint group-hover:text-primary">
                <ChevronRight className="h-4 w-4" aria-hidden />
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
