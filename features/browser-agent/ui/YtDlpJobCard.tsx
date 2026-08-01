"use client";

import { Badge } from "@/components/ui";
import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import type { YtDlpJobInfo } from "@/features/browser-agent/server/ytdlp-scheduler";

/**
 * Status + control card for the daily yt-dlp update job, built on the shared
 * {@link JobStatusCard}.
 *
 * The version badge is the point of the card: yt-dlp going stale is invisible
 * until a media download fails, so the operator sees which build is in use and
 * where it came from before anything breaks — and can pull a new one on the spot.
 */
export function YtDlpJobCard({ initial }: { initial: YtDlpJobInfo }) {
  const { status, nextRunAt, runTime, timezone, lastResult, installedVersion, source } = initial;

  return (
    <JobStatusCard
      title="yt-dlp updater"
      description={`Checks upstream for a newer yt-dlp and installs it, every day at ${runTime} (${timezone}). The media downloader picks up a new build on its next download.`}
      activity={intervalJobActivity(status)}
      runEndpoint="/api/browser/ytdlp/run"
      badges={
        installedVersion ? (
          <Badge tone="neutral">
            {installedVersion}
            {source === "system" ? " (system)" : ""}
          </Badge>
        ) : (
          <Badge tone="danger">Not installed</Badge>
        )
      }
      notice={
        installedVersion
          ? null
          : "No yt-dlp on this machine — browser_download_media fails until a check installs one."
      }
      nextRunAt={nextRunAt}
      lastRunAt={lastResult?.at ?? null}
      lastResult={lastResult?.summary ?? null}
      failed={status.lastError != null}
    />
  );
}
