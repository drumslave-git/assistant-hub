/**
 * Client-safe shared types for the consolidated Background Jobs view. Imported by
 * the server registry (the writer) and the dashboard board (the reader), so it
 * must stay free of any server-only *runtime* import — the two type imports below
 * are erased.
 */

import type { JobActivity } from "@/components/jobs/job-status";
import type { JobProgress } from "@/server/jobs/progress";

export type { JobProgress };

/** A pending-work count to surface as a badge, e.g. "12 media pending". */
export interface JobBacklog {
  label: string;
  count: number;
}

/**
 * One background job, normalized across the idle and interval schedulers so the
 * board can render every job the same way. Built by
 * {@link import("./server/registry").getAllJobs} from each feature's existing
 * `getXJobInfo` getter.
 */
export interface JobView {
  /** Stable id (matches the owning feature). */
  id: string;
  title: string;
  description: string;
  /** What the job is doing right now — drives the badge. */
  activity: JobActivity;
  /** The owning feature page, for a "details" link. */
  href: string;
  /** POSTed by the board's "Run now". */
  runEndpoint: string;
  /** Block "Run now" when there is nothing for it to do. */
  runDisabled: boolean;
  /** Why the job is not currently doing its work (e.g. paused, no LLM), or null. */
  notice: string | null;
  /** Outstanding backlog, or null when there is none. */
  backlog: JobBacklog | null;
  /** ISO time of the next run, or null when nothing is scheduled. */
  nextRunAt: string | null;
  /** Why there is no next run (shown when `nextRunAt` is null), or null. */
  nextRunNote: string | null;
  /** ISO time of the last actual run, or null when it never ran. */
  lastRunAt: string | null;
  /** One-line outcome of the last run. */
  lastResult: string | null;
  /** Render the last result as a failure. */
  failed: boolean;
  /** Live "what it does now", present only while the job is running. */
  progress: JobProgress | null;
}
