import { z } from "zod";

/**
 * Scheduled-tasks validation contract — the shape and bounds of task input,
 * shared by the service, the Route Handlers, and the dashboard form. Schedule
 * coherence (a `once` task needs a date, a `weekly` task needs weekdays) is
 * enforced by {@link normalizeSchedule} in the service, so these schemas only
 * validate field shapes.
 */

export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 4000;

/** Telegram chat id as a string (negative for groups/supergroups). */
const chatId = z.string().trim().regex(/^-?\d+$/, "Invalid chat id");
const instruction = z.string().trim().min(2, "instruction is required").max(MAX_INSTRUCTION_LENGTH);
/** Saved background for the fire; empty/null mean "none". */
const context = z.string().trim().max(MAX_CONTEXT_LENGTH).nullable();
const scheduleKind = z.enum(["once", "daily", "weekly"]);
const timeOfDay = z.string().trim().min(1);
const weekdays = z.array(z.number().int().min(0).max(6));
/** `YYYY-MM-DD`; validated fully by the schedule normalizer. */
const runDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

/** Create input (dashboard/route). Tools supply chat/user/thread from context. */
export const createScheduledTaskSchema = z.object({
  chatId,
  threadId: z.number().int().nullable().optional(),
  instruction,
  context: context.optional(),
  scheduleKind,
  timeOfDay,
  weekdays: weekdays.optional().default([]),
  runDate: runDate.nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

export type CreateScheduledTask = z.infer<typeof createScheduledTaskSchema>;

/** Partial update input; at least one field required. */
export const updateScheduledTaskSchema = z
  .object({
    instruction,
    context,
    scheduleKind,
    timeOfDay,
    weekdays,
    runDate: runDate.nullable(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateScheduledTask = z.infer<typeof updateScheduledTaskSchema>;
