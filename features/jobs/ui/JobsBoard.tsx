"use client";

import { JobStatusCard } from "@/components/jobs/JobStatusCard";
import { LiveIndicator } from "@/components/realtime/LiveIndicator";
import { Badge } from "@/components/ui";
import type { RealtimeTopic } from "@/lib/realtime";

import type { JobView } from "../types";
import { JobProgressBar } from "./JobProgressBar";

/**
 * The consolidated Background Jobs board. Renders every job through the shared
 * {@link JobStatusCard} — same badges, same "Run now", same next/last/result grid
 * — and, for a job that is currently running, its live {@link JobProgressBar}
 * inside the card.
 *
 * It subscribes to all six job topics at once, so a status or progress change on
 * any job refreshes the server-rendered board with no manual reload (the same SSE
 * layer every feature page uses).
 */
const JOB_TOPICS: RealtimeTopic[] = ["vision", "tasks", "feedback", "history", "memory", "analytics"];

export function JobsBoard({ jobs }: { jobs: JobView[] }) {
  const running = jobs.filter((job) => job.activity === "running").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {running > 0
            ? `${running} job${running === 1 ? "" : "s"} running now`
            : "No jobs running right now"}
        </p>
        <LiveIndicator topic={JOB_TOPICS} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {jobs.map((job) => (
          <JobStatusCard
            key={job.id}
            title={job.title}
            description={job.description}
            activity={job.activity}
            runEndpoint={job.runEndpoint}
            runDisabled={job.runDisabled}
            detailsHref={job.href}
            notice={job.notice ?? undefined}
            badges={
              job.backlog ? (
                <Badge tone="warning">
                  {job.backlog.count} {job.backlog.label}
                </Badge>
              ) : null
            }
            progress={job.progress ? <JobProgressBar progress={job.progress} /> : undefined}
            nextRunAt={job.nextRunAt}
            nextRunNote={job.nextRunNote}
            lastRunAt={job.lastRunAt}
            lastResult={job.lastResult}
            failed={job.failed}
          />
        ))}
      </div>
    </div>
  );
}
