import "server-only";

import { randomUUID } from "node:crypto";

import { getDb } from "@/db/drizzle";
import { getAssistantById } from "@/features/assistants/server/repository";
import { getGroupMembers } from "@/features/known-groups/server/repository";
import { getTimezone } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import { isGroupChatId } from "@/lib/telegram";
import type { TraceTrigger } from "@/lib/trace";
import { publishEvent } from "@/server/realtime/hub";
import { getStoreDb, type StoreDb } from "@/server/store/db";
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
  PROMPT_TRIGGER_KINDS,
  TIMED_TRIGGER_KINDS,
  type Task,
  type TriggerKind,
} from "../types";
import {
  appendTaskDelivery,
  countPromptTasksInScope,
  deleteTask,
  findActiveTasksByInstruction,
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
export async function getTasksView(db: StoreDb = getStoreDb()): Promise<Task[]> {
  return listTasks(db);
}

/**
 * The tasks a chat may see: its own plus the global ones, paused ones left out.
 * The chat toolkit reads through here and nowhere else, so what the bot can list
 * is exactly what it can act on (see {@link isVisibleFromChat}).
 */
export async function getChatVisibleTasks(
  assistantId: string,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<Task[]> {
  return (await listTasksForChat(db, assistantId, chatId)).filter(isVisibleFromChat);
}

/**
 * One task as a chat may see it — its own or a global one, and never a paused
 * one — or null. The whole "invisible from chat" rule lives here and in
 * {@link getChatVisibleTasks}: a paused task reads as an unknown id from chat,
 * which is what it is to the people there.
 */
export async function getChatVisibleTask(
  id: string,
  assistantId: string,
  chatId: string,
  db: StoreDb = getStoreDb(),
): Promise<Task | null> {
  const task = await getTaskById(db, id);
  if (!task || !isVisibleFromChat(task)) return null;
  // Another assistant's task is as unknown from this turn as another chat's.
  if (task.assistantId !== assistantId) return null;
  if (task.chatId !== null && task.chatId !== chatId) return null;
  return task;
}

/** One task by id, or null — the dashboard's read (a paused task included). */
export async function getTask(id: string, db: StoreDb = getStoreDb()): Promise<Task | null> {
  return getTaskById(db, id);
}

/** Substring search over instructions (optionally chat-scoped). */
export async function findTasks(
  query: string,
  chatId?: string,
  db: StoreDb = getStoreDb(),
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
  assistantId: string,
  chatId: string,
  senderUserId: string | null,
  db: StoreDb = getStoreDb(),
): Promise<{ prompt: Task[]; message: Task[] }> {
  const tasks = tasksForSender(await listTasksForChat(db, assistantId, chatId), senderUserId);
  return { prompt: promptTasks(tasks), message: messageTasks(tasks) };
}

/**
 * Record what a task-opened turn actually delivered onto each opening task's
 * capped `recent_deliveries` — the prompt-task counterpart of the scheduler's
 * post-fire stamp, and what feeds the wording-variation block the next time the
 * task matches. Best-effort per task: the message is already in the chat, so a
 * failed stamp must never fail the turn (a matched task deleted mid-turn simply
 * records nothing).
 */
export async function recordTaskDeliveries(
  taskIds: readonly string[],
  text: string,
  db: StoreDb = getStoreDb(),
): Promise<void> {
  for (const id of taskIds) {
    await appendTaskDelivery(db, id, text).catch(() => undefined);
  }
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
 * The canonical trigger, or null when the input does not describe one. For
 * lookups that run *before* the write path validates: an unusable trigger has
 * nothing to match against, and the write it precedes reports the real error.
 */
function normalizedTriggerOrNull(input: Parameters<typeof normalizeTrigger>[0]) {
  try {
    return normalizeTrigger(input);
  } catch {
    return null;
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
  db: StoreDb,
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
  // Membership is a directory read — the v1 shadow tables the consumer
  // dual-writes, not the tasks store (Phase 6 re-points it at the source).
  const members = new Set((await getGroupMembers(getDb(), chatId)).map((member) => member.userId));
  const unknown = targetUserIds.filter((id) => !members.has(id));
  if (unknown.length > 0) {
    throw ApiError.badRequest(
      `Not known to have spoken in this group: ${unknown.join(", ")}. A task can only name people the bot has seen here.`,
    );
  }
}

/** The fields that, with the instruction, decide whether two tasks are one task. */
type TaskIdentity = { instruction: string } & Pick<
  Task,
  "triggerKind" | "everyMinutes" | "delayMinutes" | "timeOfDay" | "weekdays" | "runDate"
>;

/** Whether two weekday sets name the same days, order aside. */
function sameWeekdays(a: number[] | null, b: number[] | null): boolean {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((day, i) => day === right[i]);
}

/** Whether two tasks fire on exactly the same terms. */
function sameTrigger(a: Omit<TaskIdentity, "instruction">, b: Omit<TaskIdentity, "instruction">): boolean {
  return (
    a.triggerKind === b.triggerKind &&
    a.everyMinutes === b.everyMinutes &&
    a.delayMinutes === b.delayMinutes &&
    a.timeOfDay === b.timeOfDay &&
    a.runDate === b.runDate &&
    sameWeekdays(a.weekdays, b.weekdays)
  );
}

/**
 * The task in force that `candidate` would duplicate, or null.
 *
 * A prompt task is a duplicate on its **wording alone** — the text is the rule,
 * and any trigger kind carrying it says the same thing twice in the same prompt.
 * A timed task must also agree on the **trigger and its timing** (user decision,
 * 2026-08-14): "remind me at 9" and "remind me at 18:00" are two jobs, but the
 * same words at the same time is one job asked for twice. That reverses the
 * earlier "two reminders, not noise" exemption, which cost a live pair of
 * identical reminders three seconds apart (trace `796852a6…`).
 */
async function findDuplicateTask(
  db: StoreDb,
  assistantId: string,
  chatId: string | null,
  candidate: TaskIdentity,
  exceptId?: string,
): Promise<Task | null> {
  const kinds = isPromptTask(candidate) ? PROMPT_TRIGGER_KINDS : TIMED_TRIGGER_KINDS;
  const matches = await findActiveTasksByInstruction(
    db,
    assistantId,
    chatId,
    candidate.instruction,
    kinds,
    exceptId,
  );
  if (isPromptTask(candidate)) return matches[0] ?? null;
  return matches.find((task) => sameTrigger(task, candidate)) ?? null;
}

/** Guard the per-scope cap (prompt kinds) and the duplicate rule (every kind). */
async function assertWritable(
  db: StoreDb,
  assistantId: string,
  chatId: string | null,
  candidate: TaskIdentity,
  exceptId?: string,
): Promise<void> {
  if (
    isPromptTask(candidate) &&
    !exceptId &&
    (await countPromptTasksInScope(db, assistantId, chatId)) >= MAX_PROMPT_TASKS_PER_SCOPE
  ) {
    throw ApiError.conflict(
      `At most ${MAX_PROMPT_TASKS_PER_SCOPE} standing tasks are allowed for ${scopeLabel(chatId)}`,
    );
  }
  if (await findDuplicateTask(db, assistantId, chatId, candidate, exceptId)) {
    throw ApiError.conflict("That task already exists here");
  }
}

/**
 * Everything a create/edit must normalize about the trigger + timing, shared by
 * both paths: canonical per-kind fields plus the computed `nextRunAt`.
 */
async function resolveTrigger(
  db: StoreDb,
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
  const timezone = await getTimezone();
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
    /** The chat creator's owner stamp; dashboard tasks never need it. */
    createdByOwner?: boolean;
  },
  trigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
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
      // The task's assistant must exist — the FK would reject it anyway, but
      // as a proper 400 with a name, not a constraint error.
      if (!(await getAssistantById(db, input.assistantId))) {
        throw ApiError.badRequest("Unknown assistant");
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
      await assertWritable(db, input.assistantId, input.chatId, { instruction, ...normalized });
      await trace.event({
        type: "input",
        message: "create task",
        data: { ...input, instruction, context, ...normalized, nextRunAt },
      });

      const values: InsertTask = {
        assistantId: input.assistantId,
        chatId: input.chatId,
        threadId: input.threadId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        source: input.source ?? "dashboard",
        createdByOwner: input.createdByOwner ?? false,
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
  db: StoreDb = getStoreDb(),
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
      // Checked against the *edited* shape, so a reword or a retime cannot land
      // a task on top of one already in force — and only when the result will be
      // enabled: a task being paused duplicates nothing, and refusing there would
      // block the operator's way of resolving a pair that already exists.
      if (enabled) {
        await assertWritable(db, current.assistantId, current.chatId, { instruction, ...normalized }, id);
      }

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
  db: StoreDb = getStoreDb(),
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

/**
 * May this user create a task of this kind here, from inside the chat?
 * Prompt kinds mirror the old rules gate (user decision, 2026-07-29): in a
 * private chat the user manages their own chat's standing tasks; in a group
 * only the owner may — judged by the sender's `isOwner` stamp from the
 * inbound event (the source is authoritative for owner identity since the
 * split). Timed kinds are open — any chat participant may schedule (recorded
 * decision, priority 9). Resolves a refusal reason, or null when allowed.
 */
function createDenyReason(
  chatId: string,
  userId: string | null,
  senderIsOwner: boolean,
  kind: TriggerKind,
): string | null {
  if (!isPromptTask({ triggerKind: kind })) return null;
  if (isGroupChatId(chatId)) {
    if (!senderIsOwner) {
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
 * 2026-08-07), judged on the turn's *authority* — the sender normally
 * (`senderIsOwner`, the source's stamp), a matched task's author when a task
 * drove the turn (`authorityIsOwner`).
 */
async function resolveMutationTarget(
  db: StoreDb,
  input: {
    assistantId: string;
    chatId: string;
    userId: string | null;
    senderIsOwner?: boolean;
    authorityIsOwner?: boolean;
    id: string;
  },
): Promise<{ ok: true; task: Task } | { ok: false; result: TaskWriteResult }> {
  const task = await getChatVisibleTask(input.id, input.assistantId, input.chatId, db);
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
    const denied = createDenyReason(
      input.chatId,
      input.userId,
      input.senderIsOwner === true,
      task.triggerKind,
    );
    if (denied) return { ok: false, result: { status: "denied", reason: denied } };
    return { ok: true, task };
  }
  const isOwner = input.senderIsOwner === true || input.authorityIsOwner === true;
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
    /** The turn's assistant (from the inbound event); the task is its. */
    assistantId: string;
    chatId: string;
    userId: string | null;
    /** The sender's owner stamp from the inbound event; recorded on the task. */
    senderIsOwner?: boolean;
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
  db: StoreDb = getStoreDb(),
): Promise<TaskWriteResult> {
  const denied = createDenyReason(
    input.chatId,
    input.userId,
    input.senderIsOwner === true,
    input.triggerKind,
  );
  if (denied) return { status: "denied", reason: denied };
  // Normalized here rather than trusted from the caller: the duplicate check
  // compares stored text, so untrimmed input from a tool would slip past it and
  // store the "same" task twice — the exact outcome the idempotence exists to
  // prevent. The API path is trimmed by zod; this covers every path.
  const instruction = input.instruction.trim();
  const targetUserIds = [
    ...new Set((input.targetUserIds ?? []).map((id) => id.trim()).filter(Boolean)),
  ];
  // Idempotent from chat (see `TaskWriteResult.exists`): the same task again is
  // the state the caller asked for, so report it as reached rather than as a
  // conflict. Normalized first, so "9:00" and "09:00" are recognized as the one
  // schedule they are; invalid timing skips the lookup and is rejected properly
  // by the create below.
  const trigger = normalizedTriggerOrNull({ ...input, triggerKind: input.triggerKind });
  const existing = trigger
    ? await findDuplicateTask(db, input.assistantId, input.chatId, { instruction, ...trigger })
    : null;
  if (existing) {
    // …unless a standing task is asked for with a different set of people. That
    // is not the stored state, so reporting "already in force" would be a lie
    // about the one thing that changed; amend it instead and say so.
    if (isPromptTask(input) && !sameTargets(existing.targetUserIds, targetUserIds)) {
      const task = await editTaskService(existing.id, { targetUserIds }, traceTrigger, db);
      return { status: "updated", task };
    }
    return { status: "exists", task: existing };
  }
  try {
    const task = await createTaskService(
      {
        assistantId: input.assistantId,
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
        createdByOwner: input.senderIsOwner === true,
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
    assistantId: string;
    chatId: string;
    userId: string | null;
    senderIsOwner?: boolean;
    authorityIsOwner?: boolean;
    id: string;
    patch: Omit<UpdateTaskInput, "enabled">;
  },
  traceTrigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
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
  input: {
    assistantId: string;
    chatId: string;
    userId: string | null;
    senderIsOwner?: boolean;
    authorityIsOwner?: boolean;
    id: string;
  },
  traceTrigger: TraceTrigger,
  db: StoreDb = getStoreDb(),
): Promise<TaskWriteResult> {
  const target = await resolveMutationTarget(db, input);
  if (!target.ok) return target.result;
  await removeTaskService(input.id, traceTrigger, db);
  return { status: "deleted", id: input.id };
}
