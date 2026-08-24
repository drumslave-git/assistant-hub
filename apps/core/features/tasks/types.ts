/**
 * Client-safe shared types for tasks — the unified feature that absorbed
 * scheduled tasks and chat rules (user decision, 2026-08-13). Imported by the
 * pure trigger math, the server service/repository, the Route Handlers, and the
 * dashboard UI — so it must stay free of any server-only import.
 *
 * A task is one instruction plus one trigger. The trigger kind decides how the
 * instruction ever runs:
 *
 *  - `message`  — an incoming chat message matches it (the matcher decides);
 *  - `on-reply` — never runs on its own; the instruction is composed into every
 *    reply prompt (the old shaping rules, folded in);
 *  - `interval` — every N minutes;
 *  - `timeout`  — once, a fixed delay after creation;
 *  - `schedule` — calendar-based: once on a date, daily, or weekly.
 */

/** What causes a task's instruction to run. */
export type TriggerKind = "message" | "on-reply" | "interval" | "timeout" | "schedule";

export const TRIGGER_KINDS: TriggerKind[] = [
  "message",
  "on-reply",
  "interval",
  "timeout",
  "schedule",
];

/** The trigger kinds whose instruction is composed into reply prompts. */
export const PROMPT_TRIGGER_KINDS: TriggerKind[] = ["message", "on-reply"];

/** The trigger kinds the wall-clock scheduler fires. */
export const TIMED_TRIGGER_KINDS: TriggerKind[] = ["interval", "timeout", "schedule"];

/** How a `schedule` task repeats. */
export type ScheduleKind = "once" | "daily" | "weekly";

export const SCHEDULE_KINDS: ScheduleKind[] = ["once", "daily", "weekly"];

/** Where a task was authored, kept as provenance. */
export type TaskSource = "chat" | "dashboard";

export const TASK_SOURCES: TaskSource[] = ["chat", "dashboard"];

/**
 * How many consecutive failed fires a due one-shot (`timeout`, or a `schedule`
 * of kind `once`) gets before it is disabled (kept, badged — never deleted).
 * Client-safe: the dashboard uses it to explain a disabled row.
 */
export const MAX_ONE_SHOT_ATTEMPTS = 5;

/** The schedule portion of a `schedule` task (what the wall-clock math needs). */
export interface TaskSchedule {
  scheduleKind: ScheduleKind;
  /** Local time of day as `HH:MM` (24-hour) in the task timezone. */
  timeOfDay: string;
  /** Weekdays for `weekly`, 0=Sunday..6=Saturday. */
  weekdays?: number[] | null;
  /** Calendar date for `once` as `YYYY-MM-DD` in the task timezone. */
  runDate?: string | null;
}

/** A task as returned to clients (no secrets — all fields are safe). */
export interface Task {
  id: string;
  /**
   * The assistant this task belongs to (Phase 3: tasks are per-assistant —
   * a standing order is one assistant's, and two assistants in a chat each
   * follow only their own). Dies with the assistant (store cascade).
   */
  assistantId: string;
  /**
   * The chat the task belongs to, or null for a global task (applies in every
   * chat). Only `message`/`on-reply` tasks may be global — a timed task acts in
   * a chat, so it needs one.
   */
  chatId: string | null;
  /** Forum-topic thread to deliver into, or null (the chat root). */
  threadId: number | null;
  /** Numeric Telegram user id of whoever created it, or null (dashboard). */
  createdByUserId: string | null;
  /** Where the task was authored — provenance, and half the authority rule. */
  source: TaskSource;
  /**
   * Whether the creator held owner rights when the task was created — the
   * other half of the authority rule, stamped from the source's
   * `sender.isOwner` at creation (the core holds no owner id of its own to
   * compare against since the split).
   */
  createdByOwner: boolean;
  /** The task itself, in the author's own words. */
  instruction: string;
  /**
   * Background gathered at creation time — what the instruction's references
   * (person, event, joke, topic) actually are, self-contained for a reader with
   * no chat transcript. Null when the instruction needs none. Timed kinds only:
   * a `message`/`on-reply` task runs inside a live turn that has its context.
   */
  context: string | null;
  triggerKind: TriggerKind;
  /**
   * Senders a `message`/`on-reply` task is limited to; empty means everyone in
   * the chat. Group-scoped tasks only.
   */
  targetUserIds: string[];
  /** Minutes between fires (`interval`), or null. */
  everyMinutes: number | null;
  /** Minutes after creation the one-shot fires (`timeout`, display only), or null. */
  delayMinutes: number | null;
  /** Local time of day `HH:MM` (`schedule`), or null. */
  timeOfDay: string | null;
  /** Weekdays for a weekly `schedule` (0=Sunday..6=Saturday), or null. */
  weekdays: number[] | null;
  /** Calendar date for a once `schedule` as `YYYY-MM-DD`, or null. */
  runDate: string | null;
  /** A paused task stays authored but never fires and never enters a prompt. */
  enabled: boolean;
  /** Consecutive failed fires of a due one-shot; see {@link MAX_ONE_SHOT_ATTEMPTS}. */
  attempts: number;
  /** The last few delivered message texts (newest first), for wording variation. */
  recentDeliveries: string[];
  /** ISO timestamp of the last firing, or null. */
  lastRunAt: string | null;
  /** ISO timestamp of the next firing, or null (paused, spent, or not timed). */
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Whether a task's instruction is composed into reply prompts. */
export function isPromptTask(task: Pick<Task, "triggerKind">): boolean {
  return task.triggerKind === "message" || task.triggerKind === "on-reply";
}

/**
 * Whether a task exists at all as far as a chat is concerned.
 *
 * Pausing is the operator's decision, taken in the dashboard, and a paused task
 * is invisible to the bot everywhere — not composed into a prompt, not offered
 * to the matcher, not fired, and not listed, read, changed or deleted through
 * the chat toolkit (user decision, 2026-08-14). It leaked before: a paused row
 * still came back from `tasks_list`, and the model, holding a task it could
 * neither carry out nor remove, discussed it with the chat as something it was
 * still under. A rule the bot cannot act on has nothing to say to anyone.
 */
export function isVisibleFromChat(task: Pick<Task, "enabled">): boolean {
  return task.enabled;
}

/** Whether the wall-clock scheduler owns firing this task. */
export function isTimedTask(task: Pick<Task, "triggerKind">): boolean {
  return (
    task.triggerKind === "interval" ||
    task.triggerKind === "timeout" ||
    task.triggerKind === "schedule"
  );
}
