import "server-only";

import { and, asc, desc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";

import type { DrizzleDb } from "@/db/drizzle";
import { scheduledTasks, type ScheduledTaskRow } from "@/db/schema";

import type { ScheduledTask, ScheduleKind } from "../types";

/**
 * Typed persistence for scheduled tasks. Pure data access: no policy, no
 * validation, no schedule math, no trace recording (the service owns those).
 * Every function takes a {@link DrizzleDb} so it runs against the pool or a test
 * instance.
 */

/** The number of recent delivery texts kept for wording variation. */
export const RECENT_DELIVERIES_CAP = 5;

/** Columns a create sets (the caller has already computed `nextRunAt`). */
export interface InsertScheduledTask {
  chatId: string;
  threadId: number | null;
  createdByUserId: string | null;
  instruction: string;
  context: string | null;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays: number[] | null;
  runDate: string | null;
  enabled: boolean;
  nextRunAt: Date | null;
}

/** Columns an update may set. */
export interface UpdateScheduledTask {
  instruction?: string;
  context?: string | null;
  scheduleKind?: ScheduleKind;
  timeOfDay?: string;
  weekdays?: number[] | null;
  runDate?: string | null;
  enabled?: boolean;
  attempts?: number;
  nextRunAt?: Date | null;
}

function mapRow(row: ScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    chatId: row.chatId,
    threadId: row.threadId,
    createdByUserId: row.createdByUserId,
    instruction: row.instruction,
    context: row.context,
    scheduleKind: row.scheduleKind as ScheduleKind,
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

/** All tasks (optionally scoped to one chat), newest first. */
export async function listScheduledTasks(
  db: DrizzleDb,
  chatId?: string,
): Promise<ScheduledTask[]> {
  const rows = await db.query.scheduledTasks.findMany({
    where: chatId ? eq(scheduledTasks.chatId, chatId) : undefined,
    orderBy: [desc(scheduledTasks.createdAt)],
  });
  return rows.map(mapRow);
}

/** One task by id, or null. */
export async function getScheduledTask(db: DrizzleDb, id: string): Promise<ScheduledTask | null> {
  const row = await db.query.scheduledTasks.findFirst({ where: eq(scheduledTasks.id, id) });
  return row ? mapRow(row) : null;
}

/** Substring search over instructions (optionally chat-scoped), newest first. */
export async function searchScheduledTasks(
  db: DrizzleDb,
  query: string,
  chatId?: string,
): Promise<ScheduledTask[]> {
  const q = query.trim();
  if (!q) return [];
  const like = sql`${scheduledTasks.instruction} ilike ${"%" + q + "%"}`;
  const where = chatId ? and(eq(scheduledTasks.chatId, chatId), like) : like;
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(where)
    .orderBy(desc(scheduledTasks.createdAt));
  return rows.map(mapRow);
}

/** Insert a task with an app-generated id. Returns the stored record. */
export async function insertScheduledTask(
  db: DrizzleDb,
  id: string,
  values: InsertScheduledTask,
): Promise<ScheduledTask> {
  const now = new Date();
  const [row] = await db
    .insert(scheduledTasks)
    .values({
      id,
      chatId: values.chatId,
      threadId: values.threadId,
      createdByUserId: values.createdByUserId,
      instruction: values.instruction,
      context: values.context,
      scheduleKind: values.scheduleKind,
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
export async function updateScheduledTask(
  db: DrizzleDb,
  id: string,
  patch: UpdateScheduledTask,
): Promise<ScheduledTask | null> {
  const [row] = await db
    .update(scheduledTasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(scheduledTasks.id, id))
    .returning();
  return row ? mapRow(row) : null;
}

/**
 * Record a firing on a task that still has a future run: stamp `last_run_at` and
 * the recomputed `next_run_at`. When the fire delivered a message,
 * `recentDeliveries` carries the already-capped new list (newest first); it is
 * omitted for a fire that produced no message (a failure that still advances the
 * schedule so it doesn't busy-loop).
 *
 * A task with no future run — a spent one-shot — is *deleted* by the scheduler
 * instead, so `nextRunAt` here is never null.
 */
export async function markScheduledTaskRun(
  db: DrizzleDb,
  id: string,
  input: { lastRunAt: Date; nextRunAt: Date; recentDeliveries?: string[] },
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      ...(input.recentDeliveries !== undefined
        ? { recentDeliveries: input.recentDeliveries }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, id));
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
export async function markScheduledTaskFailedAttempt(
  db: DrizzleDb,
  id: string,
  input: { lastRunAt: Date; attempts: number; disable: boolean },
): Promise<void> {
  await db
    .update(scheduledTasks)
    .set({
      lastRunAt: input.lastRunAt,
      attempts: input.attempts,
      ...(input.disable ? { enabled: false } : {}),
      updatedAt: new Date(),
    })
    .where(eq(scheduledTasks.id, id));
}

/** Delete one task. Returns true if a row was removed. */
export async function deleteScheduledTask(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db
    .delete(scheduledTasks)
    .where(eq(scheduledTasks.id, id))
    .returning({ id: scheduledTasks.id });
  return rows.length > 0;
}

/** Enabled tasks whose `next_run_at` is due (<= `now`), oldest-due first. */
export async function listDueScheduledTasks(db: DrizzleDb, now: Date): Promise<ScheduledTask[]> {
  const rows = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        isNotNull(scheduledTasks.nextRunAt),
        lte(scheduledTasks.nextRunAt, now),
      ),
    )
    .orderBy(asc(scheduledTasks.nextRunAt));
  return rows.map(mapRow);
}

/** Earliest upcoming run across enabled tasks (strictly after `now`), or null. */
export async function nextUpcomingRunAt(db: DrizzleDb, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ nextRunAt: scheduledTasks.nextRunAt })
    .from(scheduledTasks)
    .where(and(eq(scheduledTasks.enabled, true), gt(scheduledTasks.nextRunAt, now)))
    .orderBy(asc(scheduledTasks.nextRunAt))
    .limit(1);
  return row?.nextRunAt ?? null;
}

/** The recent delivered texts for a task (newest first), for wording variation. */
export async function getRecentDeliveries(db: DrizzleDb, id: string): Promise<string[]> {
  const row = await db.query.scheduledTasks.findFirst({
    where: eq(scheduledTasks.id, id),
    columns: { recentDeliveries: true },
  });
  return row?.recentDeliveries ?? [];
}
