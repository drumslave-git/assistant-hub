"use client";

import { Badge } from "@/components/ui";
import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import { DAILY_RUN_TIME_INVALID_NOTE } from "@/components/jobs/job-status";
import type { SummaryJobInfo } from "../server/summary-scheduler";

/**
 * Status + control card for the daily history-summarization job, built on the
 * shared {@link JobStatusCard}. Adds the two things specific to this job: the
 * chat-day backlog, and whether semantic search is available at all.
 */
export function SummaryJobCard({ initial }: { initial: SummaryJobInfo }) {
  const { status, pendingDays, nextRunAt, runTime, lastResult, embeddingsConfigured } = initial;

  return (
    <JobStatusCard
      title="Summaries"
      description={
        <>
          Each finished day is compressed into searchable topics, so the bot can recall
          conversations older than the last 24 hours. Runs daily at {runTime}.
          {pendingDays > 0
            ? ` ${pendingDays} chat-${pendingDays === 1 ? "day" : "days"} awaiting a summary.`
            : " Everything is summarized."}
        </>
      }
      activity={intervalJobActivity(status)}
      runEndpoint="/api/history/summaries/run"
      runDisabled={pendingDays === 0}
      badges={
        embeddingsConfigured ? null : (
          <Badge tone="warning">No embedding model — keyword search only</Badge>
        )
      }
      nextRunAt={nextRunAt}
      nextRunNote={nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE}
      lastRunAt={lastResult?.at ?? null}
      lastResult={lastResult?.summary ?? null}
      failed={status.lastError != null}
    />
  );
}
