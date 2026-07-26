/**
 * Client-safe shared types for the browser-agent feature. Imported by the server
 * service/repository/runner, the Route Handlers, and the dashboard UI — so it
 * must stay free of any server-only import.
 */

/** Lifecycle of a run: queued → running → done | failed. */
export const BROWSER_RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type BrowserRunStatus = (typeof BROWSER_RUN_STATUSES)[number];

/**
 * One download completed by a run (structural twin of the jsonb shape on
 * `browser_agent_runs.downloads`).
 */
export interface BrowserDownloadRecord {
  /** The page the file came from (the link the agent was on). */
  sourceUrl: string;
  filename: string;
  sizeBytes: number;
  /** True when the file was small enough to also attach to the chat. */
  inline: boolean;
}

/**
 * One completed browser action within a run, for the live activity feed. Appended
 * as each tool finishes, so the operator sees exactly what the agent did and in
 * what order (and where it failed).
 */
export interface BrowserRunStep {
  /** Order within the run, starting at 1. */
  seq: number;
  /** The tool that ran, e.g. `browser_navigate`, `browser_get_network`. */
  tool: string;
  /** Human action label, e.g. "navigate example.com", "download stream …". */
  action: string;
  /** Page URL at the time of the action, or null. */
  url: string | null;
  /** Whether the action succeeded. */
  ok: boolean;
  /** Short one-line outcome (page title, "5 m3u8 found", an error message, …). */
  summary: string;
  /** ISO timestamp the action finished. */
  at: string;
}

/**
 * Ephemeral live state of a run in flight (never persisted): what the agent is
 * doing *right now* and, during a download, its progress. Held in memory by the
 * runner and merged into the run detail while `status = 'running'`.
 */
export interface BrowserRunLiveState {
  /** The in-flight action label ("downloading stream …"), or null between steps. */
  currentAction: string | null;
  /** Live download progress line (bytes/speed, or ffmpeg size/time), or null. */
  progress: string | null;
}

/**
 * One search source's standing on the scoreboard the cascade sorts itself by.
 * Client-safe: the dashboard can show why the agent tries them in this order.
 */
export interface EngineStat {
  /** Source name (`DuckDuckGo`, `Google`, `Bing`, `Tavily`). */
  engine: string;
  successes: number;
  failures: number;
  /** Smoothed success rate in [0, 1] — what the ordering is actually sorted on. */
  successRate: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Why the last failure failed, or null. */
  lastError: string | null;
}

/** A browser-agent run as returned to clients (no secrets — all fields are safe). */
export interface BrowserAgentRun {
  id: string;
  /** Chat the run reports to, or null for a dashboard-started run. */
  chatId: string | null;
  threadId: number | null;
  createdByUserId: string | null;
  /** Whether the run was started by the owner (download tool enabled). */
  isOwner: boolean;
  goal: string;
  status: BrowserRunStatus;
  /** The agent's final report, or null while unfinished/failed. */
  report: string | null;
  /** Failure reason when `status = 'failed'`. */
  error: string | null;
  /** Browser actions performed. */
  steps: number;
  downloads: BrowserDownloadRecord[];
  /** Trace id of the run's execution trace, for Debug drill-down. */
  traceId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Run detail: the run plus its activity feed, screenshots, and live state. */
export interface BrowserAgentRunDetail extends BrowserAgentRun {
  /** Every completed action, in order — the activity feed. */
  activity: BrowserRunStep[];
  /** Capture-order sequence numbers of stored screenshots. */
  screenshotSeqs: number[];
  /** Live state while running (current action + download progress); null when settled. */
  live: BrowserRunLiveState | null;
}
