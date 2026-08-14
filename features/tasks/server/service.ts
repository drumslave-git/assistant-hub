import "server-only";

import { randomUUID } from "node:crypto";

import { getDb, type DrizzleDb } from "@/db/drizzle";
import { getGroupMembers } from "@/features/known-groups/server/repository";
import { getSettingsRecord } from "@/features/settings/server/repository";
import { getTimezone } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { isGroupChatId } from "@/lib/telegram";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { withTrace } from "@/server/trace";

import { messageTasks, promptTasks, sameTargets, tasksForSender } from "../format";
import {
  computeNextTriggerRun,
  computeTimeoutRun,
  describeTrigger,
  normalizeTrigger,
} from "../schedule";
import {
  isPromptTask,
  isTimedTask,
  isVisibleFromChat,
  type Task,
  type TriggerKind,
} from "../types";
import {
  countPromptTasksInScope,
  deleteTask,
  getActivePromptTaskByInstruction,
  getTaskById,
  insertTask,
  listTasks,
  listTasksForChat,
  searchTasks,
  updateTask,
  type InsertTask,
} from "./repository";
import {
  GLOBAL_SCOPE_MESSAGE,
  MAX_CONTEXT_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  MAX_PROMPT_TASKS_PER_SCOPE,
  TARGETS_SCOPE_MESSAGE,
  type CreateTask,
  type UpdateTaskInput,
} from "./schema";

/**
 * Tasks domain service — the boundary Route Handlers, the dashboard, the
 * Telegram runtime, and the MCP tools call. Owns trigger validation (via
 * `normalizeTrigger` + next-run computation in the operator timezone), the
 * scope/audience rules, the per-kind permission gates, the enabled/next-run
 * lifecycle, and trace recording for every mutation. Reads are cheap and
 * untraced.
 *
 * Two families share the row shape but not the rules:
 *
 *  - **Prompt kinds** (`message`/`on-reply`) are the old chat rules: capped per
 *    scope, deduplicated by instruction, may be global, may name people, and
 *    are gated like rules were — self-serve in a DM, owner-only in a group
 *    (user decision, 2026-07-29).
 *  - **Timed kinds** (`interval`/`timeout`/`schedule`) are the old scheduled
 *    tasks: uncapped, chat-bound, created freely from chat, mutated by their
 *    creator or the owner (user decisions, priority 9 + 2026-08-07).
 */

const FEATURE = FEATURES.tasks;

/** The scope label used in trace summaries and refusals. */
function scopeLabel(chatId: string | null): string {
  return chatId === null ? "global" : `chat ${chatId}`;
}

/** One-line summary for tool confirmations, trace output, and logs. */
export function summarizeTask(task: Task): string {
  const status = task.enabled ? "" : " (disabled)";
  const next = task.nextRunAt ? ` — next ${task.nextRunAt}` : "";
  return `${describeTrigger(task)}${status}: ${task.instruction}${next}`;
}

/* --------------------------------- reads ---------------------------------- */

/** Every task in every scope, oldest first (the dashboard view). */
export async function getTasksView(db: DrizzleDb = getDb()): Promise<Task[]> {
  return listTasks(db);
}

/**
 * The tasks a chat may see: its own plus the global ones, paused ones left out.
 * The chat toolkit reads through here and nowhere else, so what the bot can list
 * is exactly what it can act on (see {@link isVisibleFromChat}).
 */
export async function getChatVisibleTasks(
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<Task[]> {
  return (await listTasksForChat(db, chatId)).filter(isVisibleFromChat);
}

/**
 * One task as a chat may see it — its own or a global one, and never a paused
 * one — or null. The whole "invisible from chat" rule lives here and in
 * {@link getChatVisibleTasks}: a paused task reads as an unknown id from chat,
 * which is what it is to the people there.
 */
export async function getChatVisibleTask(
  id: string,
  chatId: string,
  db: DrizzleDb = getDb(),
): Promise<Task | null> {
  const task = await getTaskById(db, id);
  if (!task || !isVisibleFromChat(task)) return null;
  if (task.chatId !== null && task.chatId !== chatId) return null;
  return task;
}

/** One task by id, or null — the dashboard's read (a paused task included). */
export async function getTask(id: string, db: DrizzleDb = getDb()): Promise<Task | null> {
  return getTaskById(db, id);
}

/** Substring search over instructions (optionally chat-scoped). */
export async function findTasks(
  query: string,
  chatId?: string,
  db: DrizzleDb = getDb(),
): Promise<Task[]> {
  return searchTasks(db, query, chatId);
}

/**
 * Server-only: the enabled prompt tasks composed into a chat's reply prompt,
 * and the `message` subset that may open a turn nobody addressed. Read once per
 * incoming message by the Telegram runtime.
 *
 * `senderUserId` is who sent the message this set is being built for. Tasks
 * that name specific people are filtered against it here, before anything
 * reaches a prompt or the matcher — so a task about one member of a group is
 * simply absent for everybody else. Pass null for a turn with no sender (a
 * timed fire reading the standing block), which leaves exactly the tasks that
 * name nobody.
 */
export async function getActiveTasksForChat(
  chatId: string,
  senderUserId: string | null,
  db: DrizzleDb = getDb(),
): Promise<{ prompt: Task[]; message: Task[] }> {
  const tasks = tasksForSender(await listTasksForChat(db, chatId), senderUserId);
  return { prompt: promptTasks(tasks), message: messageTasks(tasks) };
}

/* ------------------------------- validation -------------------------------- */

function validateInstruction(raw: string): string {
  const instruction = raw.trim();
  if (instruction.length < 2) throw ApiError.badRequest("instruction is required");
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw ApiError.badRequest(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
  }
  return instruction;
}

/** Trim + bound the saved context; empty becomes null ("no context"). */
function validateContext(raw: string | null | undefined): string | null {
  const context = raw?.trim() ?? "";
  if (!context) return null;
  if (context.length > MAX_CONTEXT_LENGTH) {
    throw ApiError.badRequest(`context must be at most ${MAX_CONTEXT_LENGTH} characters`);
  }
  return context;
}

/** Validate + normalize a trigger, mapping bad input to a clean ApiError. */
function normalizeTriggerOrThrow(input: Parameters<typeof normalizeTrigger>[0]) {
  try {
    return normalizeTrigger(input);
  } catch (err) {
    throw ApiError.badRequest(err instanceof Error ? err.message : "Invalid trigger");
  }
}

/**
 * Guard who a task may name: only a group-scoped prompt task can single people
 * out, and only people the bot has actually seen in that group. Both are
 * mechanical facts — a chat id's sign, and a row in the group roster — so a
 * mistyped or invented id fails here rather than becoming a task that silently
 * never fires. A member is someone who has spoken in the group (that is how
 * the roster is built), so a lurker cannot be named until they say something.
 */
async function assertTargetsAllowed(
  db: DrizzleDb,
  chatId: string | null,
  triggerKind: TriggerKind,
  targetUserIds: readonly string[],
): Promise<void> {
  if (targetUserIds.length === 0) return;
  if (
    !isPromptTask({ triggerKind }) ||
    chatId === null ||
    !isGroupChatId(chatId)
  ) {
    throw ApiError.badRequest(TARGETS_SCOPE_MESSAGE);
  }
  const members = new Set((await getGroupMembers(db, chatId)).map((member) => member.userId));
  const unknown = targetUserIds.filter((id) => !members.has(id));
  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Not known to have spoken in this group: ${unknown.join(", ")}. A task can only name people the bot has seen here.`,
    );
  }
}

/** Guard the per-scope cap and duplicate instruction for prompt kinds. */
async function assertPromptWritable(
  db: DrizzleDb,
  chatId: string | null,
  instruction: string,
  exceptId?: string,
): Promise<void> {
  if (!exceptId && (await countPromptTasksInScope(db, chatId)) >= MAX_PROMPT_TASKS_PER_SCOPE) {
    throw ApiError.conflict(
      `At most ${MAX_PROMPT_TASKS_PER_SCOPE} standing tasks are allowed for ${scopeLabel(chatId)}`,
    );
  }
  if (await getActivePromptTaskByInstruction(db, chatId, instruction, exceptId)) {
    throw ApiError.conflict("That task already exists here");
  }
}

/**
 * Everything a create/edit must normalize about the trigger + timing, shared by
 * both paths: canonical per-kind fields plus the computed `nextRunAt`.
 */
async function resolveTrigger(
  db: DrizzleDb,
  input: Parameters<typeof normalizeTrigger>[0],
  now: Date,
): Promise<{
  trigger: ReturnType<typeof normalizeTrigger>;
  nextRunAt: Date | null;
}> {
  const trigger = normalizeTriggerOrThrow(input);
  if (trigger.triggerKind === "timeout") {
    return { trigger, nextRunAt: computeTimeoutRun(trigger.delayMinutes!, now) };
  }
  const timezone = await getTimezone(db);
  const nextRunAt = computeNextTriggerRun(trigger, now, timezone);
  if (trigger.triggerKind === "schedule" && trigger.runDate && !nextRunAt) {
    throw ApiError.badRequest("that date and time is already in the past");
  }
  return { trigger, nextRunAt };
}

/* ------------------------------ dashboard CRUD ----------------------------- */

/** Create a task, recorded as a trace. Used by the dashboard and the chat path. */
export async function createTaskService(
  input: CreateTask & {
    createdByUserId?: string | null;
    source?: "chat" | "dashboard";
  },
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Task> {
  return withTrace(
    {
      feature: FEATURE.id,
      action: "create",
      trigger,
      inputSummary: `${scopeLabel(input.chatId)}: ${input.instruction}`,
    },
    async (trace) => {
      const instruction = validateInstruction(input.instruction);
      const kind = input.triggerKind as TriggerKind;
      if (input.chatId === null && !isPromptTask({ triggerKind: kind })) {
        throw ApiError.badRequest(GLOBAL_SCOPE_MESSAGE);
      }
      const targetUserIds = input.targetUserIds ?? [];
      await assertTargetsAllowed(db, input.chatId, kind, targetUserIds);
      // Context rides only on timed kinds: a fire has no transcript to lean on,
      // while a prompt task runs inside a live turn that does.
      const context = isTimedTask({ triggerKind: kind }) ? validateContext(input.context) : null;
      const now = new Date();
      const { trigger: normalized, nextRunAt } = await resolveTrigger(
        db,
        { ...input, triggerKind: kind },
        now,
      );
      if (isPromptTask({ triggerKind: kind })) {
        await assertPromptWritable(db, input.chatId, instruction);
      }
      await trace.event({
        type: "input",
        message: "create task",
        data: { ...input, instruction, context, ...normalized, nextRunAt },
      });

      const values: InsertTask = {
        chatId: input.chatId,
        threadId: input.threadId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        source: input.source ?? "dashboard",
        instruction,
        context,
        triggerKind: normalized.triggerKind,
        targetUserIds,
        everyMinutes: normalized.everyMinutes,
        delayMinutes: normalized.delayMinutes,
        timeOfDay: normalized.timeOfDay,
        weekdays: normalized.weekdays,
        runDate: normalized.runDate,
        enabled: input.enabled ?? true,
        nextRunAt: (input.enabled ?? true) ? nextRunAt : null,
      };
      const record = await insertTask(db, randomUUID(), values);
      await trace.event({ type: "db", message: "task created", data: { nextRunAt: record.nextRunAt } });
      await trace.succeed({
        outputSummary: summarizeTask(record),
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/** Apply a validated update to a task, recomputing the next run. Traced. */
export async function editTaskService(
  id: string,
  patch: UpdateTaskInput,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<Task> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `task ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update task", data: { id, ...patch } });
      const current = await getTaskById(db, id);
      if (!current) throw ApiError.notFound("Unknown task");

      const kind = (patch.triggerKind ?? current.triggerKind) as TriggerKind;
      // Against the *stored* scope: a patch cannot move a task between chats, so
      // the chat it was agreed in is the one its rules run against.
      if (current.chatId === null && !isPromptTask({ triggerKind: kind })) {
        throw ApiError.badRequest(GLOBAL_SCOPE_MESSAGE);
      }
      const targetUserIds = isPromptTask({ triggerKind: kind })
        ? (patch.targetUserIds ?? current.targetUserIds)
        : [];
      if (patch.targetUserIds !== undefined || patch.triggerKind !== undefined) {
        await assertTargetsAllowed(db, current.chatId, kind, targetUserIds);
      }

      const instruction =
        patch.instruction !== undefined ? validateInstruction(patch.instruction) : current.instruction;
      if (isPromptTask({ triggerKind: kind }) && patch.instruction !== undefined) {
        await assertPromptWritable(db, current.chatId, instruction, id);
      }
      const context = isTimedTask({ triggerKind: kind })
        ? patch.context !== undefined
          ? validateContext(patch.context)
          : current.context
        : null;

      const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
      // Interpret timing against the current operator timezone (not one stored
      // on the row), so a timezone change re-times existing tasks on their next
      // edit or fire. A timeout re-arms from now — editing "in 1h" restarts it.
      const now = new Date();
      const { trigger: normalized, nextRunAt } = await resolveTrigger(
        db,
        {
          triggerKind: kind,
          everyMinutes:
            patch.everyMinutes !== undefined ? patch.everyMinutes : current.everyMinutes,
          delayMinutes:
            patch.delayMinutes !== undefined ? patch.delayMinutes : current.delayMinutes,
          scheduleKind: patch.scheduleKind ?? null,
          timeOfDay: patch.timeOfDay !== undefined ? patch.timeOfDay : current.timeOfDay,
          weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
          runDate: patch.runDate !== undefined ? patch.runDate : current.runDate,
        },
        now,
      );

      const record = await updateTask(db, id, {
        instruction,
        context,
        triggerKind: normalized.triggerKind,
        targetUserIds,
        everyMinutes: normalized.everyMinutes,
        delayMinutes: normalized.delayMinutes,
        timeOfDay: normalized.timeOfDay,
        weekdays: normalized.weekdays,
        runDate: normalized.runDate,
        enabled,
        // Any edit is a fresh start for the failed-fire counter — a re-enabled
        // one-shot gets its full retry budget back.
        attempts: 0,
        nextRunAt: enabled ? nextRunAt : null,
      });
      if (!record) throw ApiError.notFound("Unknown task");
      await trace.event({ type: "db", message: "task updated", data: { nextRunAt: record.nextRunAt } });
      await trace.succeed({
        outputSummary: summarizeTask(record),
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      publishEvent(FEATURE.realtimeTopic);
      return record;
    },
  );
}

/** Delete a task, recorded as a trace. */
export async function removeTaskService(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `task ${id}` },
    async (trace) => {
      const deleted = await deleteTask(db, id);
      if (!deleted) throw ApiError.notFound("Unknown task");
      await trace.event({ type: "db", message: "task deleted" });
      await trace.succeed({
        outputSummary: `deleted ${id}`,
        relatedIds: { [FEATURE.relatedIdsKey]: [id] },
      });
      publishEvent(FEATURE.realtimeTopic);
    },
  );
}

/* ------------------------------- chat-side CRUD ---------------------------- */

/** Outcome of a chat-side write, for the tool to relay. */
export type TaskWriteResult =
  | { status: "created"; task: Task }
  /**
   * The prompt task was already there, unchanged — a *success* from the chat's
   * point of view, not the conflict the dashboard gets. Creating a standing
   * task from chat is therefore idempotent: "make sure this is in force"
   * rather than "insert a row". This exists because the alternative cost a
   * real failure (trace `f33e1ede…`, 2026-07-29): asked a third time to set
   * the same rule, the model reasoned that calling the tool again "might
   * result in duplicate rules", chose to just confirm in prose, and stored
   * nothing. A tool that punishes a repeat teaches exactly that hesitation.
   */
  | { status: "exists"; task: Task }
  | { status: "updated"; task: Task }
  | { status: "deleted"; id: string }
  | { status: "denied"; reason: string }
  | { status: "not_found" };

/** The configured owner's user id, or null. Fails closed (null) on a bad read. */
async function ownerUserId(db: DrizzleDb): Promise<string | null> {
  try {
    return (await getSettingsRecord(db))?.ownerUserId ?? null;
  } catch {
    return null;
  }
}

/**
 * May this user create a task of this kind here, from inside the chat?
 * Prompt kinds mirror the old rules gate (user decision, 2026-07-29): in a
 * private chat the user manages their own chat's standing tasks; in a group
 * only the configured owner may. Timed kinds are open — any chat participant
 * may schedule (recorded decision, priority 9). Resolves a refusal reason, or
 * null when allowed.
 */
async function createDenyReason(
  db: DrizzleDb,
  chatId: string,
  userId: string | null,
  kind: TriggerKind,
): Promise<string | null> {
  if (!isPromptTask({ triggerKind: kind })) return null;
  if (isGroupChatId(chatId)) {
    const owner = await ownerUserId(db);
    if (!owner || !userId || userId !== owner) {
      return "Only the bot owner can change this group's standing rules.";
    }
    return null;
  }
  // A private chat's id equals the user id; anything else is not "their own DM".
  if (!userId || userId !== chatId) {
    return "You can only change the rules of your own chat.";
  }
  return null;
}

/**
 * Resolve a task a chat turn wants to modify, and whether this caller may.
 * A task of another chat — or a paused one — is invisible (`not_found`, never
 * "forbidden": the chat has no business learning it exists), and a global task
 * is visible but read-only from chat. Prompt kinds take the rules gate; timed
 * kinds take the creator-or-owner gate (owner exemption: user decision,
 * 2026-08-07), judged on the turn's *authority* — the sender normally, a matched
 * task's author when a task drove the turn.
 */
async function resolveMutationTarget(
  db: DrizzleDb,
  input: { chatId: string; userId: string | null; authorityUserId?: string | null; id: string },
): Promise<{ ok: true; task: Task } | { ok: false; result: TaskWriteResult }> {
  const task = await getChatVisibleTask(input.id, input.chatId, db);
  if (!task) {
    return { ok: false, result: { status: "not_found" } };
  }
  if (task.chatId === null) {
    return {
      ok: false,
      result: {
        status: "denied",
        reason:
          "That rule applies to every chat and can only be changed by the operator in the dashboard.",
      },
    };
  }
  if (isPromptTask(task)) {
    const denied = await createDenyReason(db, input.chatId, input.userId, task.triggerKind);
    if (denied) return { ok: false, result: { status: "denied", reason: denied } };
    return { ok: true, task };
  }
  const owner = await ownerUserId(db);
  const authority = input.authorityUserId ?? input.userId;
  const isOwner = Boolean(owner && authority === owner);
  if (!isOwner && (!input.userId || task.createdByUserId !== input.userId)) {
    return {
      ok: false,
      result: {
        status: "denied",
        reason:
          `Task ${input.id} was created by someone else — you can only change tasks you created. ` +
          `Only the bot's owner can change or cancel another person's task.`,
      },
    };
  }
  return { ok: true, task };
}

/** Create a task for the current chat from a chat turn, gated and traced. */
export async function createTaskFromChat(
  input: {
    chatId: string;
    userId: string | null;
    threadId?: number | null;
    instruction: string;
    context?: string | null;
    triggerKind: TriggerKind;
    targetUserIds?: string[];
    everyMinutes?: number | null;
    delayMinutes?: number | null;
    timeOfDay?: string | null;
    weekdays?: number[] | null;
    runDate?: string | null;
  },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<TaskWriteResult> {
  const denied = await createDenyReason(db, input.chatId, input.userId, input.triggerKind);
  if (denied) return { status: "denied", reason: denied };
  // Normalized here rather than trusted from the caller: the duplicate check
  // compares stored text, so untrimmed input from a tool would slip past it and
  // store the "same" task twice — the exact outcome the idempotence exists to
  // prevent. The API path is trimmed by zod; this covers every path.
  const instruction = input.instruction.trim();
  const targetUserIds = [
    ...new Set((input.targetUserIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  if (isPromptTask(input)) {
    // Idempotent from chat (see `TaskWriteResult.exists`): the same standing
    // task again is the state the caller asked for, so report it as reached.
    const existing = await getActivePromptTaskByInstruction(db, input.chatId, instruction);
    if (existing) {
      // …unless it is asked for with a different set of people. That is not the
      // stored state, so reporting "already in force" would be a lie about the
      // one thing that changed; amend it instead and say so.
      if (sameTargets(existing.targetUserIds, targetUserIds)) {
        return { status: "exists", task: existing };
      }
      const task = await editTaskService(existing.id, { targetUserIds }, traceTrigger, db);
      return { status: "updated", task };
    }
  }
  try {
    const task = await createTaskService(
      {
        chatId: input.chatId,
        threadId: input.threadId ?? null,
        instruction,
        context: input.context ?? null,
        triggerKind: input.triggerKind,
        targetUserIds,
        everyMinutes: input.everyMinutes ?? null,
        delayMinutes: input.delayMinutes ?? null,
        timeOfDay: input.timeOfDay ?? null,
        weekdays: input.weekdays ?? null,
        runDate: input.runDate ?? null,
        enabled: true,
        createdByUserId: input.userId,
        source: "chat",
      },
      traceTrigger,
      db,
    );
    return { status: "created", task };
  } catch (err) {
    // The cap and the dashboard-shaped conflicts are refusals to relay, not
    // turn-ending faults.
    if (err instanceof ApiError) return { status: "denied", reason: err.message };
    throw err;
  }
}

/**
 * Update one of the current chat's tasks from a chat turn, gated and traced.
 *
 * The patch cannot carry `enabled`: pausing and resuming are the operator's,
 * taken in the dashboard, and cancelling from chat means deleting (user
 * decision, 2026-08-14). The tool schema no longer offers the field, so the
 * refusal below is for every other caller of this service function — an honest
 * "no" the model can relay, rather than a silent drop that would answer "task
 * updated" to a request that changed nothing.
 */
export async function updateTaskFromChat(
  input: {
    chatId: string;
    userId: string | null;
    authorityUserId?: string | null;
    id: string;
    patch: Omit<UpdateTaskInput, "enabled">;
  },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<TaskWriteResult> {
  if ("enabled" in input.patch) {
    return {
      status: "denied",
      reason:
        "Tasks cannot be paused or resumed from the chat. To cancel one, delete it; only the " +
        "operator can pause a task, in the dashboard.",
    };
  }
  const target = await resolveMutationTarget(db, input);
  if (!target.ok) return target.result;
  try {
    const task = await editTaskService(input.id, input.patch, traceTrigger, db);
    return { status: "updated", task };
  } catch (err) {
    if (err instanceof ApiError) return { status: "denied", reason: err.message };
    throw err;
  }
}

/** Delete one of the current chat's tasks from a chat turn, gated and traced. */
export async function deleteTaskFromChat(
  input: { chatId: string; userId: string | null; authorityUserId?: string | null; id: string },
  traceTrigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<TaskWriteResult> {
  const target = await resolveMutationTarget(db, input);
  if (!target.ok) return target.result;
  await removeTaskService(input.id, traceTrigger, db);
  return { status: "deleted", id: input.id };
}
