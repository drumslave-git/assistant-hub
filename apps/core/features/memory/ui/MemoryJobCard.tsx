"use client";

import { Badge } from "@/components/ui";
import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import { DAILY_RUN_TIME_INVALID_NOTE } from "@/components/jobs/job-status";
import type { MemoryJobInfo } from "@/features/memory/server/scheduler";

/**
 * Status + control card for the nightly memory job — passive extraction followed
 * by consolidation — built on the shared {@link JobStatusCard}.
 *
 * Both backlogs get their own badge: they are different units (chat-days to read
 * vs notes to fold in) and different stages of the same pipeline, so collapsing
 * them into one number would hide which half is actually behind.
 */
export function MemoryJobCard({ initial }: { initial: MemoryJobInfo }) {
  const {
    status,
    nextRunAt,
    runTime,
    timezone,
    lastResult,
    pendingNotes,
    pendingExtractionDays,
    embeddingsConfigured,
  } = initial;

  return (
    <JobStatusCard
      title="Memory"
      description={`Reads each finished chat-day for durable facts — including everything said while the bot was not addressed — then folds them into durable memory, every day at ${runTime} (${timezone}).`}
      activity={intervalJobActivity(status)}
      runEndpoint="/api/memory/run"
      runDisabled={pendingNotes === 0 && pendingExtractionDays === 0}
      badges={
        <>
          <Badge tone={pendingExtractionDays > 0 ? "warning" : "neutral"}>
            {pendingExtractionDays === 0
              ? "All days read"
              : `${pendingExtractionDays} day${pendingExtractionDays === 1 ? "" : "s"} to read`}
          </Badge>
          <Badge tone={pendingNotes > 0 ? "warning" : "neutral"}>
            {pendingNotes === 0
              ? "No notes pending"
              : `${pendingNotes} note${pendingNotes === 1 ? "" : "s"} pending`}
          </Badge>
          {embeddingsConfigured ? null : (
            <Badge tone="warning">No embedding model — keyword search only</Badge>
          )}
        </>
      }
      notice={
        embeddingsConfigured ? null : (
          <>
            No embedding model is configured, so memory is stored and injected but can only be
            searched by keyword, not by meaning. Set one in Settings → Embeddings.
          </>
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
