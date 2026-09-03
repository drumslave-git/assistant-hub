import { tryParseScopedRef } from "@assistant-hub-swarm/contracts";
import { z } from "zod";


import type { ScheduleKind, TriggerKind } from "../types";

/**
 * Tasks validation contract — the single source of truth for the shape of a
 * task. Shared by the service, Route Handlers, the MCP toolkit, and the
 * dashboard. Pure (no `server-only`) so tests build inputs against the same
 * schema the handlers parse. Trigger *coherence* (an interval needs minutes, a
 * weekly schedule needs weekdays) is enforced by `normalizeTrigger` in the
 * service — these schemas validate field shapes and scope rules.
 */

/**
 * Per-scope cap on prompt-composed (`message`/`on-reply`) tasks: every one of
 * them is in every prompt, so the model has to hold all of them. Timed tasks
 * are not capped — they cost nothing until they fire.
 */
export const MAX_PROMPT_TASKS_PER_SCOPE = 32;
export const MAX_INSTRUCTION_LENGTH = 2000;
export const MAX_CONTEXT_LENGTH = 4000;
/**
 * How many people one task may single out. A task naming more of a group than
 * this is a task for the group, and the picker it is chosen from is a roster.
 */
export const MAX_TASK_TARGETS = 16;

const instruction = z
  .string()
  .trim()
  .min(2, "instruction is required")
  .max(MAX_INSTRUCTION_LENGTH, `instruction must be at most ${MAX_INSTRUCTION_LENGTH} characters`);
/** Saved background for a timed fire; empty/null mean "none". */
const context = z.string().trim().max(MAX_CONTEXT_LENGTH).nullable();
// Literal tuples rather than the exported arrays, so zod keeps the union type.
const triggerKind = z.enum([
  "message",
  "on-reply",
  "interval",
  "timeout",
  "schedule",
]) satisfies z.ZodType<TriggerKind>;
const scheduleKind = z.enum(["once", "daily", "weekly"]) satisfies z.ZodType<ScheduleKind>;
/**
 * The chat's scoped ref (`tg:chat:-100…`); null means the global scope
 * (applies in every chat; prompt kinds only).
 */
const chatRef = z
  .string()
  .trim()
  .min(1)
  .refine((ref) => tryParseScopedRef(ref)?.kind === "chat", "Not a chat ref (<transport>:chat:<id>)")
  .nullable();
/**
 * Whose messages a task applies to: empty for everyone in the chat. Normalized
 * here (trimmed, de-duplicated, order of appearance kept) so every path stores
 * the same list for the same intent and two equal target sets compare equal.
 */
const targetUserIds = z
  .array(z.string().trim().min(1))
  .max(MAX_TASK_TARGETS, `A task can name at most ${MAX_TASK_TARGETS} people`)
  .transform((ids) => [...new Set(ids)]);

/** Only a group-scoped prompt task may name senders. */
export const TARGETS_SCOPE_MESSAGE =
  "Only a message or on-reply task scoped to a group chat can be limited to specific people";
/** A chat-scoped write names its chat by scoped ref; anything else is not a chat. */
export const CHAT_REF_MESSAGE = "chatRef must be a chat ref (<transport>:chat:<id>) or null";

/** Only a prompt-composed task may span every chat. */
export const GLOBAL_SCOPE_MESSAGE =
  "Only a message or on-reply task can be global — a timed task acts in one chat";

function isPromptKind(kind: string): boolean {
  return kind === "message" || kind === "on-reply";
}

/**
 * Scope rules a create must satisfy; the service re-checks the group half
 * (whether the chat IS a group is a directory fact, not an id shape).
 */
function checkScope(
  value: { chatRef: string | null; triggerKind: string; targetUserIds: string[] },
  ctx: z.RefinementCtx,
): void {
  if (value.chatRef === null && !isPromptKind(value.triggerKind)) {
    ctx.addIssue({ code: "custom", path: ["chatRef"], message: GLOBAL_SCOPE_MESSAGE });
  }
  if (value.targetUserIds.length === 0) return;
  if (isPromptKind(value.triggerKind) && value.chatRef !== null) return;
  ctx.addIssue({ code: "custom", path: ["targetUserIds"], message: TARGETS_SCOPE_MESSAGE });
}

/** A task as returned to clients (nothing secret involved). */
export const taskSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  chatRef: z.string().nullable(),
  chatSource: z.string().nullable(),
  threadId: z.string().nullable(),
  createdByUserId: z.string().nullable(),
  source: z.enum(["chat", "dashboard"]),
  instruction: z.string(),
  context: z.string().nullable(),
  triggerKind,
  targetUserIds: z.array(z.string()),
  everyMinutes: z.number().nullable(),
  delayMinutes: z.number().nullable(),
  timeOfDay: z.string().nullable(),
  weekdays: z.array(z.number()).nullable(),
  runDate: z.string().nullable(),
  enabled: z.boolean(),
  attempts: z.number(),
  recentDeliveries: z.array(z.string()),
  lastRunAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** The trigger parameters shared by create and update. */
const triggerParams = {
  everyMinutes: z.number().int().nullable().optional(),
  delayMinutes: z.number().int().nullable().optional(),
  scheduleKind: scheduleKind.nullable().optional(),
  timeOfDay: z.string().trim().nullable().optional(),
  weekdays: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  runDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .nullable()
    .optional(),
};

/** Create input. `chatRef: null` is the global scope (dashboard only). */
export const createTaskSchema = z
  .object({
    /** The assistant this task belongs to (Phase 3: tasks are per-assistant). */
    assistantId: z.string().min(1, "An assistant is required"),
    chatRef: chatRef.optional().default(null),
    threadId: z.string().min(1).nullable().optional(),
    instruction,
    context: context.optional(),
    triggerKind,
    targetUserIds: targetUserIds.default([]),
    enabled: z.boolean().optional().default(true),
    ...triggerParams,
  })
  .superRefine(checkScope);

export type CreateTask = z.infer<typeof createTaskSchema>;

/**
 * Update input: any subset of the editable fields; at least one required. The
 * scope is not editable — moving a task between chats is a delete plus a
 * create, so a task's chat can never change under the people who agreed to it.
 * The trigger *is* editable (including its kind); the service renormalizes the
 * whole trigger and recomputes the next run. Scope rules for targets and a
 * kind change run in the service against the stored chat, which the patch
 * alone does not know.
 */
export const updateTaskSchema = z
  .object({
    instruction,
    context,
    triggerKind,
    targetUserIds,
    enabled: z.boolean(),
    ...triggerParams,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** Dashboard list filter: one chat's tasks (by scoped ref), the global set, or everything. */
export const listTasksQuerySchema = z.object({
  chatRef: z.string().optional(),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;
