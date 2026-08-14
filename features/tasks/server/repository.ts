import "server-only";

import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { tasks, type TaskRow } from "@/db/schema";

import { PROMPT_TRIGGER_KINDS, type Task, type TaskSource, type TriggerKind } from "../types";

/**
 * Typed persistence for tasks. Pure data access: no policy, no validation, no
 * trace recording (the service owns those). Every function takes a
 * {@link DrizzleDb} so the same code runs against the pool or a test instance.
 */

export const RECENT_DELIVERIES_CAP = 5;

/** Columns a create sets (the caller has already computed `nextRunAt`). */
export interface InsertTask {
  chatId: string | null;
  threadId: number | null;
  createdByUserId: string | null;
  source: TaskSource;
  instruction: string;
  context: string | null;
  triggerKind: TriggerKind;
  targetUserIds: string[];
  everyMinutes: number | null;
  delayMinutes: number | null;
  timeOfDay: string | null;
  weekdays: number[] | null;
  runDate: string | null;
  enabled: boolean;
  nextRunAt: Date | null;
}

/** Columns an update may set. */
export interface UpdateTask {
  instruction?: string;
  context?: string | null;
  triggerKind?: TriggerKind;
  targetUserIds?: string[];
  everyMinutes?: number | null;
  delayMinutes?: number | null;
  timeOfDay?: string | null;
  weekdays?: number[] | null;
  runDate?: string | null;
  enabled?: boolean;
  attempts?: number;
  nextRunAt?: Date | null;
}

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    chatId: row.chatId,
    threadId: row.threadId,
    createdByUserId: row.createdByUserId,
    source: row.source as TaskSource,
    instruction: row.instruction,
    context: row.context,
    triggerKind: row.trigger as TriggerKind,
    targetUserIds: row.targetUserIds,
    everyMinutes: row.everyMinutes,
    delayMinutes: row.delayMinutes,
    timeOfDay: row.timeOfDay,
    weekdays: row.weekdays ?? null,
    runDate: row.runDate,
    enabled: row.enabled,
    attempts: row.attempts,
    recentDeliveries: row.recentDeliveries ?? [],
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Oldest first — the order tasks were agreed in is the order they read in. */
const byAge = [asc(tasks.createdAt)];

/** All tasks (optionally scoped to one chat's own rows), oldest first. */
export async function listTasks(db: DrizzleDb, chatId?: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: chatId ? eq(tasks.chatId, chatId) : undefined,
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/**
 * The tasks that govern one chat: its own, plus every global one. Used by the
 * reply pipeline and by the chat-side tools, so both see the same set.
 */
export async function listTasksForChat(db: DrizzleDb, chatId: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: or(eq(tasks.chatId, chatId), isNull(tasks.chatId)),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** One task by id, or null. */
export async function getTaskById(db: DrizzleDb, id: string): Promise<Task | null> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  return row ? mapRow(row) : null;
}

/** Substring search over instructions (optionally chat-scoped), oldest first. */
export async function searchTasks(
  db: DrizzleDb,
  query: string,
  chatId?: string,
): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: and(
      ilike(tasks.instruction, `%${query}%`),
      chatId ? eq(tasks.chatId, chatId) : undefined,
    ),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** Scope filter: one chat's own rows, or the global set. */
function scopeWhere(chatId: string | null) {
  return chatId === null ? isNull(tasks.chatId) : eq(tasks.chatId, chatId);
}

/**
 * Number of prompt-composed (`message`/`on-reply`) tasks in one scope, for the
 * per-scope cap — every one of them is in every prompt, so the cap is a prompt
 * budget, which is why timed tasks are not counted.
 */
export async function countPromptTasksInScope(
  db: DrizzleDb,
  chatId: string | null,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(scopeWhere(chatId), inArray(tasks.trigger, PROMPT_TRIGGER_KINDS)));
  return rows[0]?.n ?? 0;
}

/**
 * The **enabled** prompt-composed task with this exact instruction in a scope
 * (case-insensitive), or null. Lets the chat path answer "that rule is already
 * in force" with the task itself instead of a bare conflict; the same
 * instruction twice is just noise in every prompt. Timed tasks are exempt —
 * "remind me to drink water" twice is two reminders, not noise.
 *
 * Paused rows are skipped, because the guard is a prompt budget and a paused
 * task is in no prompt. It is also what keeps the chat honest: "already in
 * force" about a rule the operator switched off would be a lie, and the
 * alternative — refusing with a reason — would tell the chat about a task it is
 * never shown (user decision, 2026-08-14).
 */
export async function getActivePromptTaskByInstruction(
  db: DrizzleDb,
  chatId: string | null,
  instruction: string,
  exceptId?: string,
): Promise<Task | null> {
  const parts = [
    scopeWhere(chatId),
    eq(tasks.enabled, true),
    inArray(tasks.trigger, PROMPT_TRIGGER_KINDS),
    sql`lower(${tasks.instruction}) = lower(${instruction})`,
  ];
  if (exceptId) parts.push(sql`${tasks.id} <> ${exceptId}`);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...parts))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

/** Insert a task with an app-generated id. Returns the stored record. */
export async function insertTask(db: DrizzleDb, id: string, values: InsertTask): Promise<Task> {
  const now = new Date();
  const [row] = await db
    .insert(tasks)
    .values({
      id,
      chatId: values.chatId,
      threadId: values.threadId,
      createdByUserId: values.createdByUserId,
      source: values.source,
      instruction: values.instruction,
      context: values.context,
      trigger: values.triggerKind,
      targetUserIds: values.targetUserIds,
      everyMinutes: values.everyMinutes,
      delayMinutes: values.delayMinutes,
      timeOfDay: values.timeOfDay,
      weekdays: values.weekdays,
      runDate: values.runDate,
      enabled: values.enabled,
      nextRunAt: values.nextRunAt,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return mapRow(row);
}

/** Apply a patch to one task. Returns the updated record, or null if unknown. */
export async function updateTask(
  db: DrizzleDb,
  id: string,
  patch: UpdateTask,
): Promise<Task | null> {
  const { triggerKind, ...rest } = patch;
  const [row] = await db
    .update(tasks)
    .set({
      ...rest,
      ...(triggerKind !== undefined ? { trigger: triggerKind } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Record a completed fire of a recurring task: stamp `last_run_at`, advance
 * `next_run_at`, and (when the fire delivered something) the capped
 * `recent_deliveries`. A task with no future run — a spent one-shot — is
 * *deleted* by the scheduler instead, so `nextRunAt` here is never null.
 */
export async function markTaskRun(
  db: DrizzleDb,
  id: string,
  input: { lastRunAt: Date; nextRunAt: Date; recentDeliveries?: string[] },
): Promise<void> {
  await db
    .update(tasks)
    .set({
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      ...(input.recentDeliveries !== undefined
        ? { recentDeliveries: input.recentDeliveries }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
}

/** Prepend `delivered` to `recent` and cap the list to {@link RECENT_DELIVERIES_CAP}. */
export function nextRecentDeliveries(recent: string[], delivered: string): string[] {
  return [delivered, ...recent].slice(0, RECENT_DELIVERIES_CAP);
}

/**
 * Record a failed fire of a due one-shot: stamp `last_run_at` and the new
 * attempts count, keeping `next_run_at` so the task stays due and retries on the
 * next tick. With `disable` (the attempts cap is hit) the task is switched off —
 * kept, never deleted — so the dashboard can show why it stopped.
 */
export async function markTaskFailedAttempt(
  db: DrizzleDb,
  id: string,
  input: { lastRunAt: Date; attempts: number; disable: boolean },
): Promise<void> {
  await db
    .update(tasks)
    .set({
      lastRunAt: input.lastRunAt,
      attempts: input.attempts,
      ...(input.disable ? { enabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
}

/** Delete one task. Returns true if a row was removed. */
export async function deleteTask(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  return rows.length > 0;
}

/** Enabled timed tasks whose `next_run_at` is due (<= `now`), oldest-due first. */
export async function listDueTasks(db: DrizzleDb, now: Date): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.enabled, true), isNotNull(tasks.nextRunAt), lte(tasks.nextRunAt, now)))
    .orderBy(asc(tasks.nextRunAt));
  return rows.map(mapRow);
}

/** Earliest upcoming run across enabled tasks (strictly after `now`), or null. */
export async function nextUpcomingRunAt(db: DrizzleDb, now: Date): Promise<Date | null> {
  const rows = await db
    .select({ at: tasks.nextRunAt })
    .from(tasks)
    .where(and(eq(tasks.enabled, true), isNotNull(tasks.nextRunAt), sql`${tasks.nextRunAt} > ${now}`))
    .orderBy(asc(tasks.nextRunAt))
    .limit(1);
  return rows[0]?.at ?? null;
}

/** All tasks newest first (the dashboard's timed listing prefers recency). */
export async function listTasksNewestFirst(db: DrizzleDb, chatId?: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: chatId ? eq(tasks.chatId, chatId) : undefined,
    orderBy: [desc(tasks.createdAt)],
  });
  return rows.map(mapRow);
}
