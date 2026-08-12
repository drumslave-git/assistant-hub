"use client";

import { JobStatusCard } from "@/components/jobs/JobStatusCard";
import { idleJobNextRunNote } from "@/components/jobs/job-status";
import type { IdleJobStatus } from "@/server/jobs/idle-scheduler";

/** The shape `GET/POST /api/vision/backfill` returns. */
export interface VisionBackfillView {
  status: IdleJobStatus;
  pending: number;
}

/**
 * Status + control card for the vision backfill job, built on the shared
 * {@link JobStatusCard}. The idle scheduler's phase (`idle` / `scheduled` /
 * `running`) is already a card activity, so it passes straight through.
 */
export function VisionBackfillCard({ initial }: { initial: VisionBackfillView }) {
  const { status, pending } = initial;

  return (
    <JobStatusCard
      title="Backfill"
      description={
        pending === 0
          ? "No media awaiting a description."
          : `${pending} media ${pending === 1 ? "row" : "rows"} awaiting a description. Runs automatically while the bot is quiet.`
      }
      activity={status.phase}
      runEndpoint="/api/vision/backfill"
      runDisabled={pending === 0}
      nextRunAt={status.nextRunAt}
      nextRunNote={idleJobNextRunNote(status)}
      lastRunAt={status.lastRunAt}
      lastResult={status.lastSummary}
      failed={status.lastError != null}
    />
  );
}
