import "server-only";

import { getDb } from "@/db/drizzle";
import type { AnalyticsJobInfo } from "@/features/analytics/types";
import { getAnalyticsJobInfo } from "@/features/analytics/server/scheduler";
import {
  getYtDlpJobInfo,
  type YtDlpJobInfo,
} from "@/features/browser-agent/server/ytdlp-scheduler";
import { getMessageIndexingStatus } from "@/features/history/server/index-scheduler";
import { resolveSourceContent } from "@/server/source/tg-content";
import { getSummaryJobInfo, type SummaryJobInfo } from "@/features/history/server/summary-scheduler";
import { getMemoryJobInfo, type MemoryJobInfo } from "@/features/memory/server/scheduler";
import {
  getTaskSchedulerInfo,
  type TaskSchedulerJobInfo,
} from "@/features/tasks/server/scheduler";
import {
  getSelfImprovementJobInfo,
  type SelfImprovementJobInfo,
} from "@/features/self-improvement/server/scheduler";
import { getVisionBackfillStatus } from "@/features/vision/server/backfill-scheduler";
import { getPendingMediaCount } from "@/features/vision/server/service";
import {
  DAILY_RUN_TIME_INVALID_NOTE,
  idleJobNextRunNote,
  intervalJobActivity,
  NO_UPCOMING_TASKS_NOTE,
} from "@/components/jobs/job-status";
import { featureDebugHref } from "@/lib/features";
import type { IdleJobStatus } from "@/server/jobs/idle-scheduler";

import type { JobView } from "../types";

/**
 * The one place that knows all eight background jobs — the reader half of the
 * consolidated `/jobs` dashboard. It calls each feature's existing `getXJobInfo`
 * getter and normalizes the two different scheduler status shapes (idle vs
 * interval, plus each job's own backlog/pause state) into a single {@link JobView}
 * the board renders uniformly. This coupling mirrors `register-node.ts`, which is
 * likewise the single place that starts all eight.
 *
 * The per-job mappers are pure and exported so the normalization (activity
 * derivation, last-run passthrough, backlog, progress) is unit-testable without
 * mocking every scheduler module. `getAllJobs` just fetches and composes them.
 *
 * The activity mapping and next-run notes come from the pure
 * `@/components/jobs/job-status` module — shared with the Client card, safe to
 * import here because it carries no client runtime.
 */

/** A job whose status getter failed — shown as stopped rather than dropped from the board. */
function errored(id: string, title: string, href: string): JobView {
  return {
    id,
    title,
    description: "Status unavailable.",
    activity: "stopped",
    href,
    runEndpoint: "",
    runDisabled: true,
    notice: "Could not read this job's status.",
    backlog: null,
    nextRunAt: null,
    nextRunNote: null,
    lastRunAt: null,
    lastResult: null,
    failed: true,
    progress: null,
  };
}

/** Vision backfill — the idle-debounced job; its phase is already an activity. */
export function visionJobView(status: IdleJobStatus, pendingMedia: number): JobView {
  return {
    id: "vision-backfill",
    title: "Vision backfill",
    description: "Describes media left un-captioned when it arrived. Runs while the bot is quiet.",
    activity: status.phase,
    href: "/vision",
    runEndpoint: "/api/vision/backfill",
    runDisabled: pendingMedia === 0,
    notice: null,
    backlog: pendingMedia > 0 ? { label: "media pending", count: pendingMedia } : null,
    nextRunAt: status.nextRunAt,
    nextRunNote: idleJobNextRunNote(status),
    lastRunAt: status.lastRunAt,
    lastResult: status.lastSummary,
    failed: status.lastError != null,
    progress: status.progress,
  };
}

/**
 * Message search index — the other idle-debounced job. Its backlog counts
 * messages whose searchable text is missing or out of date, which includes every
 * photo still waiting for the vision backfill to say what it shows.
 */
export function messageIndexJobView(status: IdleJobStatus, pending: number): JobView {
  return {
    id: "history-index",
    title: "Search index",
    description:
      "Indexes each message by what it says and what its media shows, so history can be " +
      "searched by meaning. Runs while the bot is quiet.",
    activity: status.phase,
    href: "/history",
    runEndpoint: "/api/history/search-index",
    runDisabled: pending === 0,
    notice: null,
    backlog: pending > 0 ? { label: "messages pending", count: pending } : null,
    nextRunAt: status.nextRunAt,
    nextRunNote: idleJobNextRunNote(status),
    lastRunAt: status.lastRunAt,
    lastResult: status.lastSummary,
    failed: status.lastError != null,
    progress: status.progress,
  };
}

/** Tasks poller — `paused` is a policy state the ticker can't know. */
export function taskJobView(info: TaskSchedulerJobInfo | null): JobView {
  if (info == null) return errored("tasks", "Task poller", "/tasks");
  return {
    id: "tasks",
    title: "Task poller",
    description:
      "Fires timed tasks at their wall-clock time; the model decides what each fire sends.",
    activity: info.paused ? "paused" : intervalJobActivity(info.status),
    href: "/tasks",
    runEndpoint: "/api/tasks/run",
    runDisabled: info.paused || info.overdue === 0,
    notice: info.paused
      ? "Firing is paused: maintenance mode is on. Due tasks are skipped, not dropped."
      : null,
    backlog: info.overdue > 0 ? { label: "overdue", count: info.overdue } : null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : NO_UPCOMING_TASKS_NOTE,
    lastRunAt: info.status.lastTickAt,
    lastResult: info.status.lastSummary,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/** History summary — daily; reports the actual run outcome, not the per-minute "waiting" tick. */
export function summaryJobView(info: SummaryJobInfo | null): JobView {
  if (info == null) return errored("history-summaries", "History summary", "/history");
  return {
    id: "history-summaries",
    title: "History summary",
    description: `Compresses each finished chat-day into searchable topic summaries, daily at ${info.runTime} (${info.timezone}).`,
    activity: intervalJobActivity(info.status),
    href: "/history",
    runEndpoint: "/api/history/summaries/run",
    runDisabled: info.pendingDays === 0,
    notice: null,
    backlog: info.pendingDays > 0 ? { label: "days pending", count: info.pendingDays } : null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE,
    lastRunAt: info.lastResult?.at ?? null,
    lastResult: info.lastResult?.summary ?? null,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/** Memory extraction + consolidation — daily. */
export function memoryJobView(info: MemoryJobInfo | null): JobView {
  if (info == null) return errored("memory", "Memory", "/memory");
  return {
    id: "memory",
    title: "Memory",
    description: `Reads each finished chat-day for durable facts and folds them into memory, daily at ${info.runTime} (${info.timezone}).`,
    activity: intervalJobActivity(info.status),
    href: "/memory",
    runEndpoint: "/api/memory/run",
    // The run does both passes, so it is only pointless when *both* backlogs are
    // empty — gating on notes alone would leave a pile of unread chat-days with no
    // way to trigger the extraction that turns them into notes.
    runDisabled: info.pendingNotes === 0 && info.pendingExtractionDays === 0,
    notice: null,
    // One badge, two backlogs: unread days come first because they are upstream —
    // reading them is what produces the notes the other number counts.
    backlog:
      info.pendingExtractionDays > 0
        ? { label: "days to read", count: info.pendingExtractionDays }
        : info.pendingNotes > 0
          ? { label: "notes pending", count: info.pendingNotes }
          : null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE,
    lastRunAt: info.lastResult?.at ?? null,
    lastResult: info.lastResult?.summary ?? null,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/** Analytics insights — daily; settles as a no-op with no LLM configured. */
export function analyticsJobView(info: AnalyticsJobInfo | null): JobView {
  if (info == null) return errored("analytics-insights", "Analytics insights", "/analytics");
  return {
    id: "analytics-insights",
    title: "Analytics insights",
    description: `Scores each chat-hour's mood + top topic and rolls up period insights, daily at ${info.runTime} (${info.timezone}).`,
    activity: intervalJobActivity(info.status),
    href: "/analytics",
    runEndpoint: "/api/analytics/insights/run",
    runDisabled: !info.llmConfigured,
    notice: info.llmConfigured
      ? null
      : "No LLM configured — set one in Settings for insights to compute.",
    backlog: info.pendingUnits > 0 ? { label: "hours pending", count: info.pendingUnits } : null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE,
    lastRunAt: info.lastResult?.at ?? null,
    lastResult: info.lastResult?.summary ?? null,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/** Self-improvement — daily; exposes no backlog count. */
export function selfImprovementJobView(info: SelfImprovementJobInfo | null): JobView {
  if (info == null) return errored("self-improvement", "Self-improvement", "/self-improvement");
  return {
    id: "self-improvement",
    title: "Self-improvement",
    description: `Distills feedback into per-user preferences and global self-corrections, daily at ${info.runTime} (${info.timezone}).`,
    activity: intervalJobActivity(info.status),
    href: "/self-improvement",
    runEndpoint: "/api/self-improvement/run",
    runDisabled: false,
    notice: null,
    backlog: null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE,
    lastRunAt: info.lastResult?.at ?? null,
    lastResult: info.lastResult?.summary ?? null,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/**
 * yt-dlp updater — daily; the only job that needs no LLM and no database. Its
 * notice carries the state an operator has to act on: no yt-dlp installed at all,
 * which is the difference between "media downloads may be stale" and "media
 * downloads do not work".
 */
export function ytdlpJobView(info: YtDlpJobInfo | null): JobView {
  // Details go to this job's own trace filter, not to /browser: unlike the
  // other jobs it has no data page — the browser-agent page merely hosts its
  // card — and landing an operator on "Browser agent" answers nothing about
  // what the updater did. Its runs ARE its details.
  if (info == null) return errored("ytdlp-updater", "yt-dlp updater", featureDebugHref("ytdlp-updater"));
  return {
    id: "ytdlp-updater",
    title: "yt-dlp updater",
    description: `Keeps the media downloader's yt-dlp current against upstream releases, daily at ${info.runTime} (${info.timezone}).`,
    activity: intervalJobActivity(info.status),
    href: featureDebugHref("ytdlp-updater"),
    runEndpoint: "/api/browser/ytdlp/run",
    runDisabled: false,
    notice:
      info.source === "missing"
        ? "No yt-dlp installed — media downloads fail until a check installs one."
        : null,
    backlog: null,
    nextRunAt: info.nextRunAt,
    nextRunNote: info.nextRunAt ? null : DAILY_RUN_TIME_INVALID_NOTE,
    lastRunAt: info.lastResult?.at ?? null,
    lastResult: info.lastResult?.summary ?? null,
    failed: info.status.lastError != null,
    progress: info.status.progress,
  };
}

/**
 * Every background job's current state, in a stable order. Each getter is guarded
 * so one failing job cannot blank the whole board.
 */
export async function getAllJobs(): Promise<JobView[]> {
  const [pendingMedia, pendingIndex, tasks, selfImprovement, summary, memory, analytics, ytdlp] =
    await Promise.all([
      getPendingMediaCount().catch(() => 0),
      (resolveSourceContent()?.indexDue(0).then((due) => due.total) ?? Promise.resolve(0)).catch(
        () => 0,
      ),
      getTaskSchedulerInfo().catch(() => null),
      getSelfImprovementJobInfo().catch(() => null),
      getSummaryJobInfo().catch(() => null),
      getMemoryJobInfo().catch(() => null),
      getAnalyticsJobInfo().catch(() => null),
      getYtDlpJobInfo().catch(() => null),
    ]);
  const vision = getVisionBackfillStatus();
  const index = getMessageIndexingStatus();

  return [
    visionJobView(vision, pendingMedia),
    messageIndexJobView(index, pendingIndex),
    taskJobView(tasks),
    summaryJobView(summary),
    memoryJobView(memory),
    analyticsJobView(analytics),
    selfImprovementJobView(selfImprovement),
    ytdlpJobView(ytdlp),
  ];
}
