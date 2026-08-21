"use client";

import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import { DAILY_RUN_TIME_INVALID_NOTE } from "@/components/jobs/job-status";
import { Badge } from "@/components/ui";

import type { AnalyticsJobInfo } from "../types";

/**
 * Status + control card for the analytics insight job, built on the shared
 * {@link JobStatusCard}. A Client Component (like every other feature's job card)
 * so the badge/notice nodes are constructed on the client — the shared card is a
 * Client Component and is always driven from one, never directly from a Server
 * Component.
 */
export function AnalyticsJobCard({ job }: { job: AnalyticsJobInfo }) {
  return (
    <JobStatusCard
      title="Insight job"
      description="Scores each finished day's mood + top topic, then rolls up the month/year/all-time word & topic. Runs nightly."
      activity={intervalJobActivity(job.status)}
      runEndpoint="/api/analytics/insights/run"
      runDisabled={!job.llmConfigured}
      notice={
        job.llmConfigured
          ? undefined
          : "No LLM configured — set one in Settings for insights to compute."
      }
      badges={
        job.pendingUnits > 0 ? (
          <Badge tone="warning">{job.pendingUnits} hour(s) pending</Badge>
        ) : (
          <Badge tone="success">Up to date</Badge>
        )
      }
      nextRunAt={job.nextRunAt}
      nextRunNote={job.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE}
      lastRunAt={job.lastResult?.at ?? null}
      lastResult={job.lastResult?.summary ?? null}
    />
  );
}
