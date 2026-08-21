"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  type BadgeTone,
} from "@/components/ui";
import { Timestamp } from "@/components/time/Timestamp";
import type { ApiErrorBody } from "@/lib/api-error";

import type { JobActivity } from "./job-status";

/**
 * The one status + control card for a background job. Every scheduler-backed
 * feature (vision backfill, history summaries, self-improvement, scheduled tasks)
 * renders this instead of its own copy: the same activity badge, the same "Run
 * now" mechanics, and the same next/last/result grid.
 *
 * A feature supplies only what is genuinely its own — the wording, the endpoint,
 * and, via {@link JobStatusCardProps.notice}, the reason its work is currently
 * *not* happening. That last one matters: a job that silently declines to run
 * (paused, unconfigured, nothing to do) is the failure mode an operator cannot
 * diagnose from a dashboard that only ever shows "Enabled".
 *
 * Live updates arrive over the page's SSE subscription — every shared scheduler
 * publishes on each status change — and `router.refresh()` after a run re-reads
 * the server-rendered props.
 */

// Re-exported so existing card imports keep working; the definitions live in
// the pure `./job-status` module, which the server-only jobs registry also uses.
export { intervalJobActivity, type JobActivity } from "./job-status";

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

export interface JobStatusCardProps {
  title: string;
  description: ReactNode;
  activity: JobActivity;
  /** POSTed by "Run now". Only the error body of the response is read. */
  runEndpoint: string;
  /**
   * Why the job is not currently doing its work (e.g. paused by maintenance, no
   * LLM configured). Rendered prominently — this is the answer to "why did
   * nothing happen?".
   */
  notice?: ReactNode;
  /** Extra badges rendered after the activity badge. */
  badges?: ReactNode;
  /** Block "Run now" when there is nothing for it to do. */
  runDisabled?: boolean;
  /** When set, a "Details" link to the owning feature page (used by the Jobs board). */
  detailsHref?: string;
  /**
   * Live "what it does now" content, rendered prominently above the grid while the
   * job is running (e.g. a progress bar). Omit when the job is not running.
   */
  progress?: ReactNode;
  /** When the job next runs, or null when nothing is scheduled. */
  nextRunAt: string | null;
  /**
   * Why there is no next run, shown in the "Next run" cell when `nextRunAt` is
   * null (e.g. "when the bot next goes quiet…"). An unexplained "—" reads as
   * broken; for idle-debounced jobs an empty next-run is the normal state.
   */
  nextRunNote?: string | null;
  /** When the job last ran, or null when it never has. */
  lastRunAt: string | null;
  /** One-line outcome of the last run. */
  lastResult: string | null;
  /** Render the last result as a failure. */
  failed?: boolean;
}

export function JobStatusCard({
  title,
  description,
  activity,
  runEndpoint,
  notice,
  badges,
  runDisabled = false,
  detailsHref,
  progress,
  nextRunAt,
  nextRunNote,
  lastRunAt,
  lastResult,
  failed = false,
}: JobStatusCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = activity === "running";

  async function runNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(runEndpoint, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
        setError(body.error?.message ?? `Request failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="space-y-1">
          <CardTitle className="flex flex-wrap items-center gap-2">
            {title}
            <Badge tone={ACTIVITY_TONE[activity]} dot>
              {ACTIVITY_LABEL[activity]}
            </Badge>
            {badges}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <CardAction>
          {detailsHref ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={detailsHref}>Details</Link>
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runNow}
            disabled={busy || running || runDisabled}
            leftIcon={<RefreshCw className="h-4 w-4" />}
          >
            {running ? "Running…" : busy ? "Starting…" : "Run now"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-sm text-muted">
        {progress ? <div className="mb-3">{progress}</div> : null}
        {notice ? (
          <p className="mb-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
            {notice}
          </p>
        ) : null}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt>Next run</dt>
            <dd className="text-foreground">
              {nextRunAt || !nextRunNote ? (
                <Timestamp iso={nextRunAt} />
              ) : (
                <span className="text-muted">{nextRunNote}</span>
              )}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Last run</dt>
            <dd className="text-foreground">
              <Timestamp iso={lastRunAt} />
            </dd>
          </div>
          <div className="flex justify-between gap-4 sm:col-span-2">
            <dt>Last result</dt>
            <dd className={failed ? "text-danger" : "text-foreground"}>{lastResult ?? "—"}</dd>
          </div>
        </dl>
        {error ? <p className="mt-2 text-danger">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
