"use client";

import Link from "next/link";

import { Badge } from "@/components/ui";
import { JobStatusCard, intervalJobActivity } from "@/components/jobs/JobStatusCard";
import { NO_UPCOMING_TASKS_NOTE } from "@/components/jobs/job-status";
import type { TaskSchedulerJobInfo } from "../server/scheduler";

/**
 * Status + control card for the tasks poller, built on the shared
 * {@link JobStatusCard}.
 *
 * Its reason for existing beyond the shared card is the pause notice: maintenance
 * mode stops *every* fire, so an enabled task with a next-run time in the past
 * simply never arrives. That was previously invisible here — the page showed a
 * green "Enabled" badge and a next-run time, and the message silently never came.
 */
export function TaskSchedulerCard({ initial }: { initial: TaskSchedulerJobInfo }) {
  const { status, paused, overdue, nextRunAt } = initial;

  return (
    <JobStatusCard
      title="Task poller"
      description="Checks every 30 seconds for timed tasks that have come due; the model decides what each fire sends."
      activity={paused ? "paused" : intervalJobActivity(status)}
      runEndpoint="/api/tasks/run"
      // "Run now" cannot deliver anything while maintenance pauses firing, and
      // there is nothing to do when no task is due — don't offer a no-op button.
      runDisabled={paused || overdue === 0}
      notice={
        paused ? (
          <>
            <strong className="font-medium">Firing is paused: maintenance mode is on.</strong> No
            timed task fires in any chat while it stays on. Due tasks are skipped, not dropped —
            they keep their place and fire on the next tick once you turn maintenance off in{" "}
            <Link href="/settings" className="underline underline-offset-2">
              Settings
            </Link>
            .
          </>
        ) : null
      }
      badges={
        overdue > 0 ? (
          <Badge tone={paused ? "danger" : "warning"}>
            {overdue} overdue {overdue === 1 ? "task" : "tasks"}
          </Badge>
        ) : null
      }
      nextRunAt={nextRunAt}
      nextRunNote={nextRunAt ? null : NO_UPCOMING_TASKS_NOTE}
      lastRunAt={status.lastTickAt}
      lastResult={status.lastSummary}
      failed={status.lastError != null}
    />
  );
}
