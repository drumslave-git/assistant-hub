import "server-only";

import { ApiError } from "@/lib/api-error";
import { silencedAssistantIds } from "@/server/ownership";
import type { TraceTrigger } from "@/lib/trace";
import { getGroupContext, getGroupLanguage } from "@/features/known-groups/server/service";
import { getUserContext, getUserLanguage } from "@/features/known-users/server/service";
import { getToolset } from "@/features/mcp-tools/server/service";
import { getAssistantPersona } from "@/features/assistants/server/service";
import { getBotPolicy, getLlmRuntime, getTimezone } from "@/features/settings/server/service";
import { FEATURES } from "@/lib/features";
import { resolveRequiredLanguage } from "@/lib/language";
import { isGroupChatId } from "@/lib/telegram";
import {
  chatCompletion,
  type ChatCompletionResult,
  type ChatMessage,
  type LlmCallTrace,
} from "@/server/llm/client";
import { chatCompletionWithTools } from "@/server/llm/tool-loop";
import {
  createIntervalScheduler,
  type IntervalJobStatus,
  type IntervalRunContext,
  type IntervalScheduler,
} from "@/server/jobs/interval-scheduler";
import { withAdvisoryLock } from "@/server/jobs/lock";
import type { JobProgress } from "@/server/jobs/progress";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";

import { buildStandingTasksBlock } from "../format";
import { computeNextTriggerRun } from "../schedule";
import { isPromptTask, MAX_ONE_SHOT_ATTEMPTS } from "../types";
import { fireTask, type FireResult } from "./fire";
import {
  deleteTask,
  getTaskById,
  listDueTasks,
  markTaskFailedAttempt,
  markTaskRun,
  nextRecentDeliveries,
  nextUpcomingRunAt,
} from "./repository";
import { getActiveTasksForChat } from "./service";

/**
 * In-process periodic scheduler for timed tasks, owned by a single `globalThis`
 * singleton (like the bot manager, MCP registry, and vision-backfill scheduler)
 * so there is exactly one per process and it survives HMR.
 *
 * Unlike the idle-debounced vision backfill, this is a fixed-interval poller
 * ({@link import("@/server/jobs/interval-scheduler")}): a task must fire at its
 * wall-clock instant regardless of whether the bot is busy. Each tick, under a
 * cross-process advisory lock, it scans for due tasks, fires each, then
 * advances `next_run_at` — or deletes the task outright once it is spent (a
 * one-shot that has fired). Firing is paused while maintenance mode is on. The
 * LLM connection is read fresh per tick.
 *
 * A fire delivers only through the source app's own `send_message` tool, so
 * this is the one caller that asks {@link getToolset} for a `send` delivery.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 30_000;

const FEATURE = FEATURES.tasks;
const STORE_KEY = Symbol.for("assistant-hub.tasks.scheduler");

/**
 * Collaborators the due-run loop needs. Injected so the whole tick can be
 * driven against a real database with a capturing delivery sink + deterministic
 * generator — no live bot or LLM (the same simulation approach as the
 * message-flow tests).
 */
export interface DueRunDeps {
  /** IANA timezone the schedules are interpreted in when advancing. */
  timezone: string;
  /**
   * Resolve the persona for one task's assistant (real: the v2 assistants
   * store). Per task, because every fire runs as ITS assistant.
   */
  personaFor: (assistantId: string) => Promise<string | null>;
  /**
   * Run the completion (real: `chatCompletionWithTools` with the outbound
   * toolset). Called inside the task chat's tool context; the exchange records
   * itself on the fire trace via the shared LLM tracing layer (`trace`).
   */
  complete: (messages: ChatMessage[], trace?: LlmCallTrace) => Promise<ChatCompletionResult>;
  /** Now, for the due scan + schedule advance. Defaults to the wall clock. */
  now?: Date;
  /** Publish live per-task progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: StoreDb;
}

/**
 * The chat-scoped prompt pieces every fire composes, resolved per task (live
 * reply parity): the configured reply language, the chat identity context
 * (roster with @usernames in a group, the person in a DM — a DM chat id is the
 * user id) so the fire can address its target by a mention that actually
 * notifies, and the chat's standing tasks (null sender: a fire is nobody's
 * message, so a task that singles people out has no one to single out). All
 * best-effort — an unreadable piece degrades to the generic bot rather than
 * blocking the fire. Shared by the due-run loop and the dashboard's manual
 * fire.
 */
async function loadChatScopedFireDeps(assistantId: string, chatId: string, db: StoreDb) {
  const [storedLanguage, chatContext, standingTasks] = await Promise.all([
    (isGroupChatId(chatId) ? getGroupLanguage(chatId) : getUserLanguage(chatId)).catch(() => null),
    // Directory context is a v1 shadow read (its own default db) until
    // Phase 6 re-points it at the source.
    (isGroupChatId(chatId)
      ? getGroupContext(chatId).then((c) => c?.content ?? null)
      : getUserContext(chatId).then((c) => c?.content ?? null)
    ).catch(() => null),
    getActiveTasksForChat(assistantId, chatId, null, db)
      .then(({ prompt }) => buildStandingTasksBlock(prompt))
      .catch(() => null),
  ]);
  return {
    requiredLanguage: resolveRequiredLanguage(storedLanguage),
    chatContext,
    standingTasks,
  };
}

/**
 * Fire every currently-due task and settle its schedule. Pure of scheduling
 * mechanics (the caller owns the lock/interval): scans due rows, fires each via
 * the injected collaborators, then either stamps `last_run_at`/`next_run_at` +
 * the capped `recent_deliveries` (a recurring task) or deletes the row (a spent
 * one-shot — it has had its turn and can never fire again). Never throws per
 * task — a failing fire still settles so it doesn't busy-loop.
 */
export async function runDueTasks(deps: DueRunDeps): Promise<{ fired: number; failed: number }> {
  const db = deps.db ?? getStoreDb();
  const now = deps.now ?? new Date();
  const allDue = await listDueTasks(db, now);
  // Offboarding (Phase 9): a deactivated account's assistants fire nothing.
  // Their rows stay due (untouched), so reactivation resumes them.
  const silenced = await silencedAssistantIds(db);
  const due = allDue.filter((task) => !silenced.has(task.assistantId));
  if (due.length === 0) return { fired: 0, failed: 0 };

  let fired = 0;
  let failed = 0;
  for (const task of due) {
    deps.onProgress?.({
      step: `Firing: ${task.instruction.slice(0, 60)}`,
      current: fired + failed + 1,
      total: due.length,
    });
    // A due row always has a chat (the DB check pins global scope to prompt
    // kinds, which never carry a next_run_at) — narrow it once here.
    const chatId = task.chatId!;
    const [scoped, personalityPrompt] = await Promise.all([
      loadChatScopedFireDeps(task.assistantId, chatId, db),
      deps.personaFor(task.assistantId).catch(() => null),
    ]);
    const result = await fireTask(task, {
      personalityPrompt,
      ...scoped,
      complete: deps.complete,
      db,
    }).catch(() => ({ ok: false as const, sent: [] as string[] }));
    if (result.ok) fired += 1;
    else failed += 1;

    // Settle the schedule. A recurring task advances regardless of fire success
    // (the next occurrence self-heals, and advancing prevents a busy-loop). A
    // one-shot that *fired* is spent and is deleted — it can never fire again —
    // while a one-shot that *failed* keeps its due `next_run_at` and retries on
    // later ticks, up to MAX_ONE_SHOT_ATTEMPTS, then is disabled — never
    // deleted — so a transient outage cannot silently eat a reminder (user
    // decision, 2026-07-20). Every fire is recorded in its trace.
    const nextRunAt = computeNextTriggerRun(task, now, deps.timezone);
    if (nextRunAt) {
      await markTaskRun(db, task.id, {
        lastRunAt: now,
        nextRunAt,
        recentDeliveries:
          result.ok && result.sent.length > 0
            ? result.sent.reduce(
                (acc, text) => nextRecentDeliveries(acc, text),
                task.recentDeliveries ?? [],
              )
            : undefined,
      }).catch(() => undefined);
    } else if (result.ok) {
      await deleteTask(db, task.id).catch(() => undefined);
    } else {
      const attempts = task.attempts + 1;
      await markTaskFailedAttempt(db, task.id, {
        lastRunAt: now,
        attempts,
        disable: attempts >= MAX_ONE_SHOT_ATTEMPTS,
      }).catch(() => undefined);
    }
    publishEvent(FEATURE.realtimeTopic);
  }
  return { fired, failed };
}

/**
 * The real LLM + bot collaborators a fire runs with, or null when the LLM is
 * not configured. Shared by the poll tick and the dashboard's manual fire.
 */
async function buildLiveFireCollaborators(): Promise<Pick<
  DueRunDeps,
  "personaFor" | "complete"
> | null> {
  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return null;
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };
  return {
    // Every fire runs as ITS task's assistant (Phase 3).
    personaFor: (assistantId) => getAssistantPersona(assistantId),
    // A fire delivers only through `send_message`: nothing triggered it, so
    // there is no message to reply to. No tools on the toolset means a plain
    // completion (the fire then simply cannot send — a quiet fire).
    //
    // Resolved per fire rather than per tick, because which tool connections
    // are offered depends on the firing task's assistant — and the fire has
    // already bound its tool context by the time this runs, so the scope is
    // read from there.
    complete: async (messages, trace) => {
      const toolset = await getToolset({ delivery: "send" }).catch(() => null);
      return toolset
        ? chatCompletionWithTools(conn, {
            model: runtime.model,
            messages,
            tools: toolset.tools,
            callTool: toolset.callTool,
            ...(trace ? { trace } : {}),
          })
        : chatCompletion(conn, {
            model: runtime.model,
            messages,
            ...(trace ? { trace } : {}),
          });
    },
  };
}

/** One poll tick: wire the real LLM + bot collaborators and fire due tasks under the lock. */
async function runTick(ctx?: IntervalRunContext): Promise<{ summary: string }> {
  // Pause firing during maintenance — the bot is owner-only then, so it should
  // not push proactive task messages into arbitrary chats.
  const policy = await getBotPolicy().catch(() => null);
  if (policy?.maintenanceModeEnabled) return { summary: "paused (maintenance)" };

  const live = await buildLiveFireCollaborators();
  if (!live) return { summary: "LLM not configured" };

  const outcome = await withAdvisoryLock("tasks", async () => {
    const timezone = await getTimezone().catch(() => "UTC");
    return runDueTasks({ timezone, ...live, onProgress: ctx?.reportProgress });
  });

  if (!outcome.ran) return { summary: "skipped (locked elsewhere)" };
  const { fired, failed } = outcome.result;
  return { summary: `${fired} fired${failed ? `, ${failed} failed` : ""}` };
}

/**
 * Fire one timed task immediately, on the operator's explicit request (the
 * dashboard's "Fire now"). Runs the exact fire path — same prompt composition,
 * tool context, and delivery — but is deliberately OFF the schedule's books:
 * `next_run_at`, `last_run_at`, `attempts` and `recent_deliveries` are not
 * touched, and a one-shot is not consumed (user decision, 2026-08-18 — a
 * manual fire does not count as a regular one). Recorded as
 * `tasks`/`manual-fire` with the caller's trigger, so operator-initiated runs
 * are distinguishable in Debug. Maintenance mode does not block it: this is an
 * explicit operator action, not a background push. No advisory lock either — a
 * manual fire mutates no schedule state, so it cannot corrupt a concurrent
 * tick; at worst a task due this very instant delivers twice, which is the
 * operator's own timing.
 */
export async function manualFireTask(
  id: string,
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
  // Injectable like DueRunDeps, so tests drive a capturing sink + fake LLM.
  liveOverride?: Pick<DueRunDeps, "personaFor" | "complete">,
): Promise<FireResult> {
  const task = await getTaskById(db, id);
  if (!task) throw ApiError.notFound("Unknown task");
  if (isPromptTask(task)) {
    throw ApiError.badRequest(
      "Only a timed task can be fired manually — a message/on-reply task runs inside live turns",
    );
  }
  const live = liveOverride ?? (await buildLiveFireCollaborators());
  if (!live) {
    throw ApiError.serviceUnavailable(
      "LLM is not configured — set the endpoint and model in Settings",
    );
  }
  // A timed task always has a chat (the DB scope check); narrow once.
  const chatId = task.chatId!;
  const [scoped, personalityPrompt] = await Promise.all([
    loadChatScopedFireDeps(task.assistantId, chatId, db),
    live.personaFor(task.assistantId).catch(() => null),
  ]);
  return fireTask(
    task,
    {
      personalityPrompt,
      ...scoped,
      complete: live.complete,
      db,
    },
    { action: "manual-fire", trigger },
  );
}

function scheduler(): IntervalScheduler {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: IntervalScheduler };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createIntervalScheduler({
      name: "tasks",
      tickMs: TICK_MS,
      onStatusChange: () => publishEvent(FEATURE.realtimeTopic),
      run: (ctx) => runTick(ctx),
    });
  }
  return g[STORE_KEY];
}

/** Start the periodic task poller (boot). Idempotent. */
export function startTaskScheduler(): void {
  scheduler().start();
}

/** Stop the poller (shutdown). */
export function stopTaskScheduler(): void {
  scheduler().stop();
}

/** Trigger one poll tick as soon as possible (dashboard "Run due now"). */
export function runTaskSchedulerNow(): Promise<void> {
  return scheduler().runNow();
}

/** Job info for the dashboard card. */
export interface TaskSchedulerJobInfo {
  status: IntervalJobStatus;
  /** True while maintenance mode pauses firing. */
  paused: boolean;
  /** How many enabled tasks are currently due (waiting for the next tick). */
  overdue: number;
  /** ISO instant of the next upcoming run across enabled tasks, or null. */
  nextRunAt: string | null;
  /** When this snapshot was taken. */
  asOf: string;
}

/** Current job info — the ticker's status plus the policy/backlog around it. */
export async function getTaskSchedulerInfo(db: StoreDb = getStoreDb()): Promise<TaskSchedulerJobInfo> {
  const now = new Date();
  const [policy, due, next] = await Promise.all([
    getBotPolicy().catch(() => null),
    listDueTasks(db, now).catch(() => []),
    nextUpcomingRunAt(db, now).catch(() => null),
  ]);

  return {
    status: scheduler().getStatus(),
    paused: policy?.maintenanceModeEnabled ?? false,
    overdue: due.length,
    nextRunAt: next?.toISOString() ?? null,
    asOf: now.toISOString(),
  };
}
