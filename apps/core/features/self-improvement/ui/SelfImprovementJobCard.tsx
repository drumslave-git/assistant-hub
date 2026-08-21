"use client";

import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import { DAILY_RUN_TIME_INVALID_NOTE } from "@/components/jobs/job-status";
import type { SelfImprovementJobInfo } from "@/features/self-improvement/server/scheduler";

/**
 * Status + control card for the daily self-improvement job, built on the shared
 * {@link JobStatusCard}.
 */
export function SelfImprovementJobCard({ initial }: { initial: SelfImprovementJobInfo }) {
  const { status, nextRunAt, runTime, timezone, lastResult } = initial;

  return (
    <JobStatusCard
      title="Daily incorporation"
      description={`Distills collected feedback into per-user preferences and global self-corrections, every day at ${runTime} (${timezone}).`}
      activity={intervalJobActivity(status)}
      runEndpoint="/api/self-improvement/run"
      nextRunAt={nextRunAt}
      nextRunNote={nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE}
      lastRunAt={lastResult?.at ?? null}
      lastResult={lastResult?.summary ?? null}
      failed={status.lastError != null}
    />
  );
}
