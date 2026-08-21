import { Loader2 } from "lucide-react";

import type { JobProgress } from "../types";

/**
 * Live "what it does now" for a running job: the current step, and — when the run
 * is a countable loop — a determinate progress bar with an `n / total` count.
 * Work whose length isn't known up front (`total` omitted) shows an indeterminate
 * spinner + step instead of a misleading bar.
 *
 * Fed by the scheduler progress channel (`server/jobs/progress.ts`) via the Jobs
 * registry, and re-rendered live as the board refreshes on SSE events.
 */
export function JobProgressBar({ progress }: { progress: JobProgress }) {
  const { step, current, total } = progress;
  const determinate = typeof current === "number" && typeof total === "number" && total > 0;
  const pct = determinate ? Math.min(100, Math.round((current! / total!) * 100)) : 0;

  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex min-w-0 items-center gap-2 text-foreground">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
          <span className="truncate">{step}</span>
        </span>
        {determinate ? (
          <span className="shrink-0 tabular-nums text-muted">
            {current} / {total}
          </span>
        ) : null}
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuenow={determinate ? pct : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={step}
      >
        <div
          className={
            determinate
              ? "h-full rounded-full bg-primary transition-[width] duration-500"
              : "h-full w-1/3 rounded-full bg-primary/60 animate-pulse motion-reduce:animate-none"
          }
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
