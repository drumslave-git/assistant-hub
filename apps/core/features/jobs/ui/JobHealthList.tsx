import Link from "next/link";

import { Timestamp } from "@/components/time/Timestamp";
import {
  Badge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  type BadgeTone,
} from "@/components/ui";
import type { JobActivity } from "@/components/jobs/job-status";

import type { JobView } from "../types";

/**
 * A compact, read-only row per background job — the Overview's answer to "is
 * anything quietly not running?".
 *
 * Deliberately not the {@link import("./JobsBoard").JobsBoard}: that board is
 * the place to *operate* a job (run it now, read its live progress, open its
 * feature page) and eight of those cards is a page of its own. This shows the
 * three facts that make a job's silence diagnosable — what it is doing, when it
 * next runs, and how the last run ended — and links to the board for the rest.
 *
 * The activity mapping is the same shared one the board's cards use, so the two
 * views cannot disagree about what "paused" looks like.
 */

const ACTIVITY_LABEL: Record<JobActivity, string> = {
  running: "Running",
  idle: "Idle",
  scheduled: "Scheduled",
  stopped: "Stopped",
  paused: "Paused",
};

const ACTIVITY_TONE: Record<JobActivity, BadgeTone> = {
  running: "success",
  idle: "neutral",
  scheduled: "warning",
  stopped: "danger",
  paused: "warning",
};

export function JobHealthList({ jobs }: { jobs: JobView[] }) {
  return (
    <Table minWidth={640}>
      <TableHead>
        <TableRow header>
          <TableHeaderCell>Job</TableHeaderCell>
          <TableHeaderCell>State</TableHeaderCell>
          <TableHeaderCell>Next run</TableHeaderCell>
          <TableHeaderCell>Last result</TableHeaderCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id}>
            <TableCell>
              <Link href={job.href} className="font-medium text-foreground hover:text-primary">
                {job.title}
              </Link>
              {/* The reason a job is declining to work — the answer to "why did
                  nothing happen?" — outranks everything else on the row. */}
              {job.notice ? <p className="mt-0.5 text-xs text-warning">{job.notice}</p> : null}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={ACTIVITY_TONE[job.activity]} dot>
                  {ACTIVITY_LABEL[job.activity]}
                </Badge>
                {job.backlog ? (
                  <Badge tone="warning">
                    {job.backlog.count} {job.backlog.label}
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap text-muted">
              {job.nextRunAt || !job.nextRunNote ? (
                <Timestamp iso={job.nextRunAt} />
              ) : (
                <span className="text-faint">{job.nextRunNote}</span>
              )}
            </TableCell>
            <TableCell className={job.failed ? "text-danger" : "text-muted"}>
              {job.lastResult ?? "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
