import "server-only";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { recordAssistantMessage } from "@/features/history/server/service";
import { getGroupLanguage } from "@/features/known-groups/server/service";
import { getUserLanguage } from "@/features/known-users/server/service";
import { getToolset } from "@/features/mcp-tools/server/service";
import { getActivePersonalityPrompt } from "@/features/personalities/server/service";
import { getBotPolicy, getLlmRuntime, getTimezone } from "@/features/settings/server/service";
import { buildChatRulesBlock } from "@/features/chat-rules/format";
import { getActiveRulesForChat } from "@/features/chat-rules/server/service";
import { getActiveSpecialistInstructions } from "@/features/specialists/server/service";
import { FEATURES } from "@/lib/features";
import { resolveRequiredLanguage } from "@/lib/language";
import { isGroupChatId } from "@/lib/telegram";
import { chatCompletion, type ChatCompletionResult, type ChatMessage } from "@/server/llm/client";
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
import { sendChatMessage } from "@/server/telegram/bot-manager";

import { computeNextRun } from "../schedule";
import { MAX_ONE_SHOT_ATTEMPTS } from "../types";
import { fireScheduledTask, type FireToolCall } from "./fire";
import {
  deleteScheduledTask,
  listDueScheduledTasks,
  markScheduledTaskFailedAttempt,
  markScheduledTaskRun,
  nextRecentDeliveries,
  nextUpcomingRunAt,
} from "./repository";

/**
 * In-process periodic scheduler for scheduled tasks, owned by a single
 * `globalThis` singleton (like the bot manager, MCP registry, and vision-backfill
 * scheduler) so there is exactly one per process and it survives HMR.
 *
 * Unlike the idle-debounced vision backfill, this is a fixed-interval poller
 * ({@link import("@/server/jobs/interval-scheduler")}): a task must fire at its
 * wall-clock instant regardless of whether the bot is busy. Each tick, under a
 * cross-process advisory lock, it scans for due tasks, fires each, then advances
 * `next_run_at` — or deletes the task outright once it is spent (a one-shot that
 * has fired). Firing is paused while maintenance mode is on. The LLM connection
 * is read fresh per tick.
 */

/** Poll period. A code constant, not a setting. */
const TICK_MS = 30_000;

const FEATURE = FEATURES["scheduled-tasks"];
const STORE_KEY = Symbol.for("llm-tg-bot.scheduled-tasks.scheduler");

/**
 * Collaborators the due-run loop needs. Injected so the whole tick can be driven
 * against a real database with a capturing reply sink + deterministic generator —
 * no live bot or LLM (the same simulation approach as the message-flow tests).
 */
export interface DueRunDeps {
  /** IANA timezone the schedules are interpreted in when advancing. */
  timezone: string;
  /** Active persona prompt for the fire's system prompt, or null. */
  personalityPrompt: string | null;
  /**
   * Generate the task message (real: `chatCompletionWithTools` when tools are
   * registered, else `chatCompletion`). Called inside the task chat's tool
   * context; tool calls are reported back for the fire trace.
   */
  complete: (
    messages: ChatMessage[],
    onToolCall?: (call: FireToolCall) => void | Promise<void>,
  ) => Promise<ChatCompletionResult>;
  /** Deliver to a chat (real: the bot's `sendChatMessage`); resolves the message id. */
  send: (chatId: string, text: string, opts: { threadId?: number | null }) => Promise<{ messageId: number }>;
  /** Mirror a delivered message into history (real: `recordAssistantMessage`). */
  recordReply?: (input: { chatId: string; telegramMessageId: number; content: string }) => Promise<void>;
  /** Now, for the due scan + schedule advance. Defaults to the wall clock. */
  now?: Date;
  /** Publish live per-task progress to the scheduler (drives the Jobs dashboard). */
  onProgress?: (progress: JobProgress | null) => void;
  db?: DrizzleDb;
}

/**
 * Fire every currently-due task and settle its schedule. Pure of scheduling
 * mechanics (the caller owns the lock/interval): scans due rows, fires each via
 * the injected collaborators, then either stamps `last_run_at`/`next_run_at` +
 * the capped `recent_deliveries` (a recurring task) or deletes the row (a spent
 * one-shot — it has had its turn and can never fire again). Never throws per task
 * — a failing fire still settles so it doesn't busy-loop.
 */
export async function runDueScheduledTasks(deps: DueRunDeps): Promise<{ fired: number; failed: number }> {
  const db = deps.db ?? getDb();
  const now = deps.now ?? new Date();
  const due = await listDueScheduledTasks(db, now);
  if (due.length === 0) return { fired: 0, failed: 0 };

  let fired = 0;
  let failed = 0;
  for (const task of due) {
    deps.onProgress?.({
      step: `Firing: ${task.instruction.slice(0, 60)}`,
      current: fired + failed + 1,
      total: due.length,
    });
    // The fired message must be in the chat's configured language, like a normal
    // reply. A private chat's id is the user id; a group's names the group — the
    // kind selects which registry to read. Unset → the default language.
    const storedLanguage = await (
      isGroupChatId(task.chatId) ? getGroupLanguage(task.chatId) : getUserLanguage(task.chatId)
    ).catch(() => null);
    // The firing chat's active specialist — per chat, so it is resolved per
    // task, like the language. Best-effort: unreadable → the generic bot.
    const specialistInstructions = await getActiveSpecialistInstructions(task.chatId, db).catch(
      () => null,
    );
    // The chat's standing rules, resolved per task for the same reason. Only the
    // reply-shaping set applies: an `always` rule reacts to somebody's message,
    // and a fire is nobody's message. Nobody's message is also why the sender is
    // null: a rule that singles people out has no one to single out here.
    const chatRules = await getActiveRulesForChat(task.chatId, null, db)
      .then((rules) => buildChatRulesBlock(rules.reply))
      .catch(() => null);
    const result = await fireScheduledTask(task, {
      personalityPrompt: deps.personalityPrompt,
      specialistInstructions,
      chatRules,
      requiredLanguage: resolveRequiredLanguage(storedLanguage),
      complete: deps.complete,
      send: (text) => deps.send(task.chatId, text, { threadId: task.threadId }),
      recordReply: deps.recordReply,
      db,
    }).catch(() => ({ ok: false as const }));
    if (result.ok) fired += 1;
    else failed += 1;

    // Settle the schedule. A recurring task advances regardless of fire success
    // (the next occurrence self-heals, and advancing prevents a busy-loop). A
    // one-shot that *fired* is spent and is deleted — it can never fire again
    // (creation rejects a past one-shot), so keeping the row would only leave a
    // dead entry. A one-shot that *failed* keeps its due `next_run_at` and
    // retries on later ticks, up to MAX_ONE_SHOT_ATTEMPTS, then is disabled —
    // never deleted — so a transient outage cannot silently eat a reminder
    // (user decision, 2026-07-20). Every fire is recorded in its trace.
    const nextRunAt = computeNextRun(task, now, deps.timezone);
    if (nextRunAt) {
      await markScheduledTaskRun(db, task.id, {
        lastRunAt: now,
        nextRunAt,
        recentDeliveries: result.ok
          ? nextRecentDeliveries(task.recentDeliveries ?? [], result.text!)
          : undefined,
      }).catch(() => undefined);
    } else if (result.ok) {
      await deleteScheduledTask(db, task.id).catch(() => undefined);
    } else {
      const attempts = task.attempts + 1;
      await markScheduledTaskFailedAttempt(db, task.id, {
        lastRunAt: now,
        attempts,
        disable: attempts >= MAX_ONE_SHOT_ATTEMPTS,
      }).catch(() => undefined);
    }
    publishEvent(FEATURE.realtimeTopic);
  }
  return { fired, failed };
}

/** One poll tick: wire the real LLM + bot collaborators and fire due tasks under the lock. */
async function runTick(ctx?: IntervalRunContext): Promise<{ summary: string }> {
  // Pause firing during maintenance — the bot is owner-only then, so it should
  // not push proactive task messages into arbitrary chats.
  const policy = await getBotPolicy().catch(() => null);
  if (policy?.maintenanceModeEnabled) return { summary: "paused (maintenance)" };

  const runtime = await getLlmRuntime().catch(() => null);
  if (!runtime) return { summary: "LLM not configured" };
  const conn = { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, backend: runtime.backend };

  const outcome = await withAdvisoryLock("scheduled-tasks", async () => {
    const [timezone, personalityPrompt, toolset] = await Promise.all([
      getTimezone().catch(() => "UTC"),
      getActivePersonalityPrompt().catch(() => null),
      // Fires run with the full toolset, like a live reply, so a specialist
      // check-in can read/write its own entries mid-fire (the fire binds the
      // task's chat as the tool context). No tools registered → plain completion.
      getToolset().catch(() => null),
    ]);
    return runDueScheduledTasks({
      timezone,
      personalityPrompt,
      complete: (messages, onToolCall) =>
        toolset
          ? chatCompletionWithTools(conn, {
              model: runtime.model,
              messages,
              tools: toolset.tools,
              callTool: toolset.callTool,
              onToolCall: (rec) =>
                onToolCall?.({ name: rec.name, args: rec.args, result: rec.result, ok: rec.ok }),
            })
          : chatCompletion(conn, { model: runtime.model, messages }),
      send: (chatId, text, opts) => sendChatMessage(chatId, text, opts),
      onProgress: ctx?.reportProgress,
      recordReply: (input) =>
        recordAssistantMessage({
          chatId: input.chatId,
          telegramMessageId: input.telegramMessageId,
          content: input.content,
          replyToMessageId: null,
        }).then(() => undefined),
    });
  });

  if (!outcome.ran) return { summary: "skipped (locked elsewhere)" };
  const { fired, failed } = outcome.result;
  return { summary: `${fired} fired${failed ? `, ${failed} failed` : ""}` };
}

function scheduler(): IntervalScheduler {
  const g = globalThis as typeof globalThis & { [STORE_KEY]?: IntervalScheduler };
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createIntervalScheduler({
      name: "scheduled-tasks",
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
  /**
   * True when maintenance mode is pausing every fire. The poller keeps ticking
   * and due tasks stay due — they are skipped, not advanced — so they deliver
   * once maintenance is turned off. Without this the dashboard shows a healthy
   * "Enabled" task whose message never arrives and gives no reason why.
   */
  paused: boolean;
  /** Enabled tasks whose scheduled instant has already passed. */
  overdue: number;
  /** Earliest upcoming run across enabled tasks, or null when nothing is scheduled. */
  nextRunAt: string | null;
  /** The instant this snapshot was taken — the baseline "overdue" is measured against. */
  asOf: string;
}

/** Current job info — the ticker's status plus the policy/backlog around it. */
export async function getTaskSchedulerInfo(db: DrizzleDb = getDb()): Promise<TaskSchedulerJobInfo> {
  const now = new Date();
  const [policy, due, next] = await Promise.all([
    getBotPolicy(db).catch(() => null),
    listDueScheduledTasks(db, now).catch(() => []),
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
