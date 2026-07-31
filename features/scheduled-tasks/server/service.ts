import "server-only";

import { randomUUID } from "node:crypto";

import type { DrizzleDb } from "@/db/drizzle";
import { getDb } from "@/db/drizzle";
import { getTimezone } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import { FEATURES } from "@/lib/features";
import type { TraceTrigger } from "@/lib/trace";
import { withTrace } from "@/server/trace";

import { computeNextRun, describeSchedule, normalizeSchedule } from "../schedule";
import type { ScheduledTask, ScheduleKind } from "../types";
import {
  deleteScheduledTask,
  getScheduledTask,
  insertScheduledTask,
  listScheduledTasks,
  searchScheduledTasks,
  updateScheduledTask,
} from "./repository";
import { MAX_CONTEXT_LENGTH, MAX_INSTRUCTION_LENGTH } from "./schema";

/**
 * Scheduled-tasks domain service — the boundary Route Handlers, the dashboard,
 * and the MCP tools call. Owns schedule validation (via {@link normalizeSchedule}
 * + next-run computation in the operator timezone), the enabled/next-run
 * lifecycle, and trace recording for every mutation. Reads are cheap and untraced.
 */

const FEATURE = FEATURES["scheduled-tasks"];

/** Create input; `chatId` is required, the rest come from context or the form. */
export interface CreateScheduledTaskInput {
  chatId: string;
  threadId?: number | null;
  createdByUserId?: string | null;
  instruction: string;
  /** Saved background for the fire; empty/absent stores null. */
  context?: string | null;
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays?: number[] | null;
  runDate?: string | null;
  enabled?: boolean;
}

/** Partial update input. */
export interface UpdateScheduledTaskInput {
  instruction?: string;
  /** New saved background; empty string or null clears it, absent leaves it. */
  context?: string | null;
  scheduleKind?: ScheduleKind;
  timeOfDay?: string;
  weekdays?: number[] | null;
  runDate?: string | null;
  enabled?: boolean;
}

/** One-line summary for tool confirmations and logs. */
export function summarizeTask(task: ScheduledTask): string {
  const status = task.enabled ? "" : " (disabled)";
  const next = task.nextRunAt ? ` — next ${task.nextRunAt}` : "";
  return `${describeSchedule(task)}${status}: ${task.instruction}${next}`;
}

/** Validate + normalize a schedule, mapping bad input to a clean ApiError. */
function normalizeOrThrow(input: {
  scheduleKind: ScheduleKind;
  timeOfDay: string;
  weekdays?: number[] | null;
  runDate?: string | null;
}) {
  try {
    return normalizeSchedule(input);
  } catch (err) {
    throw ApiError.badRequest(err instanceof Error ? err.message : "Invalid schedule");
  }
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

function validateInstruction(raw: string): string {
  const instruction = raw.trim();
  if (instruction.length < 2) throw ApiError.badRequest("instruction is required");
  if (instruction.length > MAX_INSTRUCTION_LENGTH) {
    throw ApiError.badRequest(`instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
  }
  return instruction;
}

/** All tasks (optionally scoped to one chat), newest first. */
export async function getScheduledTasks(
  chatId?: string,
  db: DrizzleDb = getDb(),
): Promise<ScheduledTask[]> {
  return listScheduledTasks(db, chatId);
}

/** One task by id, or null. */
export async function getTask(id: string, db: DrizzleDb = getDb()): Promise<ScheduledTask | null> {
  return getScheduledTask(db, id);
}

/** Substring search over instructions (optionally chat-scoped). */
export async function findTasks(
  query: string,
  chatId?: string,
  db: DrizzleDb = getDb(),
): Promise<ScheduledTask[]> {
  return searchScheduledTasks(db, query, chatId);
}

/** Create a scheduled task, recorded as a trace. */
export async function createScheduledTaskService(
  input: CreateScheduledTaskInput,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ScheduledTask> {
  return withTrace(
    { feature: FEATURE.id, action: "create", trigger, inputSummary: input.instruction },
    async (trace) => {
      const instruction = validateInstruction(input.instruction);
      const context = validateContext(input.context);
      const schedule = normalizeOrThrow(input);
      const timezone = await getTimezone(db);
      await trace.event({
        type: "input",
        message: "create scheduled task",
        data: { chatId: input.chatId, instruction, context, ...schedule, timezone },
      });

      const nextRunAt = computeNextRun(schedule, new Date(), timezone);
      if (schedule.scheduleKind === "once" && !nextRunAt) {
        throw ApiError.badRequest("that date and time is already in the past");
      }

      const record = await insertScheduledTask(db, randomUUID(), {
        chatId: input.chatId,
        threadId: input.threadId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        instruction,
        context,
        scheduleKind: schedule.scheduleKind,
        timeOfDay: schedule.timeOfDay,
        weekdays: schedule.weekdays,
        runDate: schedule.runDate,
        enabled: input.enabled ?? true,
        nextRunAt,
      });
      await trace.event({ type: "db", message: "task created", data: { nextRunAt: record.nextRunAt } });
      await trace.succeed({
        outputSummary: summarizeTask(record),
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      return record;
    },
  );
}

/** Apply a validated update to a task, recomputing the next run. Traced. */
export async function editScheduledTaskService(
  id: string,
  patch: UpdateScheduledTaskInput,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<ScheduledTask> {
  return withTrace(
    { feature: FEATURE.id, action: "update", trigger, inputSummary: `task ${id}` },
    async (trace) => {
      await trace.event({ type: "input", message: "update scheduled task", data: { id, ...patch } });
      const current = await getScheduledTask(db, id);
      if (!current) throw ApiError.notFound("Unknown task");

      const schedule = normalizeOrThrow({
        scheduleKind: patch.scheduleKind ?? current.scheduleKind,
        timeOfDay: patch.timeOfDay ?? current.timeOfDay,
        weekdays: patch.weekdays !== undefined ? patch.weekdays : current.weekdays,
        runDate: patch.runDate !== undefined ? patch.runDate : current.runDate,
      });
      const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
      // Interpret the schedule against the current operator timezone (not one stored
      // on the row), so a timezone change re-times existing tasks on their next edit
      // or fire.
      const timezone = await getTimezone(db);
      const nextRunAt = enabled ? computeNextRun(schedule, new Date(), timezone) : null;
      if (enabled && schedule.scheduleKind === "once" && !nextRunAt) {
        throw ApiError.badRequest("that date and time is already in the past");
      }
      const instruction =
        patch.instruction !== undefined ? validateInstruction(patch.instruction) : current.instruction;
      const context = patch.context !== undefined ? validateContext(patch.context) : current.context;

      const record = await updateScheduledTask(db, id, {
        instruction,
        context,
        scheduleKind: schedule.scheduleKind,
        timeOfDay: schedule.timeOfDay,
        weekdays: schedule.weekdays,
        runDate: schedule.runDate,
        enabled,
        // Any operator edit is a fresh start for the failed-fire counter — a
        // re-enabled one-shot gets its full retry budget back.
        attempts: 0,
        nextRunAt,
      });
      if (!record) throw ApiError.notFound("Unknown task");
      await trace.event({ type: "db", message: "task updated", data: { nextRunAt: record.nextRunAt } });
      await trace.succeed({
        outputSummary: summarizeTask(record),
        relatedIds: { [FEATURE.relatedIdsKey]: [record.id] },
      });
      return record;
    },
  );
}

/** Delete a task, recorded as a trace. */
export async function removeScheduledTaskService(
  id: string,
  trigger: TraceTrigger,
  db: DrizzleDb = getDb(),
): Promise<void> {
  return withTrace(
    { feature: FEATURE.id, action: "delete", trigger, inputSummary: `task ${id}` },
    async (trace) => {
      const deleted = await deleteScheduledTask(db, id);
      if (!deleted) throw ApiError.notFound("Unknown task");
      await trace.event({ type: "db", message: "task deleted" });
      await trace.succeed({ outputSummary: `deleted ${id}`, relatedIds: { [FEATURE.relatedIdsKey]: [id] } });
    },
  );
}
