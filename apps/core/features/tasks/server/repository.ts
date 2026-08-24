import "server-only";

import { parseScopedRef, scopedRef } from "@assistant-hub/contracts";
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";

import { tasks, type TaskRow } from "../../../store/schema";
import type { StoreDb } from "@/server/store/db";

import { PROMPT_TRIGGER_KINDS, type Task, type TaskSource, type TriggerKind } from "../types";

/**
 * Typed persistence for tasks, over the v2 core store (the Phase 3 flip):
 * per-assistant rows, chat/user identity stored as scoped refs. Pure data
 * access: no policy, no validation, no trace recording (the service owns
 * those). Every function takes a {@link StoreDb} so the same code runs
 * against the pool or a test instance.
 *
 * Ref translation happens HERE, at the storage boundary: the feature keeps
 * speaking source-local ids ("-1001", "42") because every caller does — the
 * inbound event's parsed refs, the chat tools, the dashboard. All refs are
 * `tg:*` until the chat source lands (Phase 4) and generalizes the service
 * surface; the store shape is already source-neutral.
 */

export const RECENT_DELIVERIES_CAP = 5;

const toChatRef = (chatId: string | null): string | null =>
  chatId === null ? null : scopedRef("tg", "chat", chatId);
const toUserRef = (userId: string | null): string | null =>
  userId === null ? null : scopedRef("tg", "user", userId);
const refId = (ref: string | null): string | null => (ref === null ? null : parseScopedRef(ref).id);

/** Columns a create sets (the caller has already computed `nextRunAt`). */
export interface InsertTask {
  assistantId: string;
  chatId: string | null;
  threadId: number | null;
  createdByUserId: string | null;
  source: TaskSource;
  createdByOwner: boolean;
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
    assistantId: row.assistantId,
    chatId: refId(row.chatRef),
    threadId: row.threadId,
    createdByUserId: refId(row.createdByUserRef),
    source: row.source as TaskSource,
    createdByOwner: row.createdByOwner,
    instruction: row.instruction,
    context: row.context,
    triggerKind: row.trigger as TriggerKind,
    targetUserIds: row.targetUserRefs.map((ref) => parseScopedRef(ref).id),
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

/** All tasks across assistants (optionally one chat's rows), oldest first. */
export async function listTasks(db: StoreDb, chatId?: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: chatId ? eq(tasks.chatRef, toChatRef(chatId)!) : undefined,
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/**
 * The tasks that govern one chat FOR ONE ASSISTANT: its own rows plus every
 * global one. Used by the reply pipeline and by the chat-side tools, so both
 * see the same set — two assistants in the same chat each see only their own
 * standing orders.
 */
export async function listTasksForChat(
  db: StoreDb,
  assistantId: string,
  chatId: string,
): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: and(
      eq(tasks.assistantId, assistantId),
      or(eq(tasks.chatRef, toChatRef(chatId)!), isNull(tasks.chatRef)),
    ),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** One task by id, or null. */
export async function getTaskById(db: StoreDb, id: string): Promise<Task | null> {
  const row = await db.query.tasks.findFirst({ where: eq(tasks.id, id) });
  return row ? mapRow(row) : null;
}

/** Substring search over instructions (optionally chat-scoped), oldest first. */
export async function searchTasks(db: StoreDb, query: string, chatId?: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: and(
      ilike(tasks.instruction, `%${query}%`),
      chatId ? eq(tasks.chatRef, toChatRef(chatId)!) : undefined,
    ),
    orderBy: byAge,
  });
  return rows.map(mapRow);
}

/** Scope filter: one chat's own rows, or the global set. */
function scopeWhere(chatId: string | null) {
  return chatId === null ? isNull(tasks.chatRef) : eq(tasks.chatRef, toChatRef(chatId)!);
}

/**
 * Number of prompt-composed (`message`/`on-reply`) tasks in one assistant's
 * scope, for the per-scope cap — every one of them is in every prompt of THAT
 * assistant, so the cap is a per-assistant prompt budget, which is why timed
 * tasks are not counted.
 */
export async function countPromptTasksInScope(
  db: StoreDb,
  assistantId: string,
  chatId: string | null,
): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(
      and(
        eq(tasks.assistantId, assistantId),
        scopeWhere(chatId),
        inArray(tasks.trigger, PROMPT_TRIGGER_KINDS),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * The **enabled** tasks in one assistant's scope whose instruction is exactly
 * this text (case-insensitive), restricted to `kinds`, oldest first. The raw
 * material of the duplicate guard — per assistant, because the same rule on
 * two assistants is two different standing orders. See the v1 note on why
 * paused rows are skipped (user decision, 2026-08-14).
 */
export async function findActiveTasksByInstruction(
  db: StoreDb,
  assistantId: string,
  chatId: string | null,
  instruction: string,
  kinds: TriggerKind[],
  exceptId?: string,
): Promise<Task[]> {
  const parts = [
    eq(tasks.assistantId, assistantId),
    scopeWhere(chatId),
    eq(tasks.enabled, true),
    inArray(tasks.trigger, kinds),
    sql`lower(${tasks.instruction}) = lower(${instruction})`,
  ];
  if (exceptId) parts.push(sql`${tasks.id} <> ${exceptId}`);
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...parts))
    .orderBy(...byAge);
  return rows.map(mapRow);
}

/** Insert a task with an app-generated id. Returns the stored record. */
export async function insertTask(db: StoreDb, id: string, values: InsertTask): Promise<Task> {
  const now = new Date();
  const [row] = await db
    .insert(tasks)
    .values({
      id,
      assistantId: values.assistantId,
      chatRef: toChatRef(values.chatId),
      threadId: values.threadId,
      createdByUserRef: toUserRef(values.createdByUserId),
      source: values.source,
      createdByOwner: values.createdByOwner,
      instruction: values.instruction,
      context: values.context,
      trigger: values.triggerKind,
      targetUserRefs: values.targetUserIds.map((userId) => scopedRef("tg", "user", userId)),
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
export async function updateTask(db: StoreDb, id: string, patch: UpdateTask): Promise<Task | null> {
  const { triggerKind, targetUserIds, ...rest } = patch;
  const [row] = await db
    .update(tasks)
    .set({
      ...rest,
      ...(triggerKind !== undefined ? { trigger: triggerKind } : {}),
      ...(targetUserIds !== undefined
        ? { targetUserRefs: targetUserIds.map((userId) => scopedRef("tg", "user", userId)) }
        : {}),
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
  db: StoreDb,
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
 * Record one delivered text onto a task's capped `recent_deliveries` — the
 * prompt-task counterpart of {@link markTaskRun}'s deliveries stamp, for a
 * matched `message` task whose turn just sent through `reply_to_message`.
 * Touches nothing else: a prompt task has no schedule to advance.
 */
export async function appendTaskDelivery(
  db: StoreDb,
  id: string,
  delivered: string,
): Promise<void> {
  const row = await db.query.tasks.findFirst({
    where: eq(tasks.id, id),
    columns: { recentDeliveries: true },
  });
  if (!row) return;
  await db
    .update(tasks)
    .set({
      recentDeliveries: nextRecentDeliveries(row.recentDeliveries ?? [], delivered),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
}

/**
 * Record a failed fire of a due one-shot: stamp `last_run_at` and the new
 * attempts count, keeping `next_run_at` so the task stays due and retries on the
 * next tick. With `disable` (the attempts cap is hit) the task is switched off —
 * kept, never deleted — so the dashboard can show why it stopped.
 */
export async function markTaskFailedAttempt(
  db: StoreDb,
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
export async function deleteTask(db: StoreDb, id: string): Promise<boolean> {
  const rows = await db.delete(tasks).where(eq(tasks.id, id)).returning({ id: tasks.id });
  return rows.length > 0;
}

/** Enabled timed tasks whose `next_run_at` is due (<= `now`), oldest-due first — every assistant's. */
export async function listDueTasks(db: StoreDb, now: Date): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.enabled, true), isNotNull(tasks.nextRunAt), lte(tasks.nextRunAt, now)))
    .orderBy(asc(tasks.nextRunAt));
  return rows.map(mapRow);
}

/** Earliest upcoming run across enabled tasks (strictly after `now`), or null. */
export async function nextUpcomingRunAt(db: StoreDb, now: Date): Promise<Date | null> {
  const rows = await db
    .select({ at: tasks.nextRunAt })
    .from(tasks)
    .where(and(eq(tasks.enabled, true), isNotNull(tasks.nextRunAt), sql`${tasks.nextRunAt} > ${now}`))
    .orderBy(asc(tasks.nextRunAt))
    .limit(1);
  return rows[0]?.at ?? null;
}

/** All tasks newest first (the dashboard's timed listing prefers recency). */
export async function listTasksNewestFirst(db: StoreDb, chatId?: string): Promise<Task[]> {
  const rows = await db.query.tasks.findMany({
    where: chatId ? eq(tasks.chatRef, toChatRef(chatId)!) : undefined,
    orderBy: [desc(tasks.createdAt)],
  });
  return rows.map(mapRow);
}
