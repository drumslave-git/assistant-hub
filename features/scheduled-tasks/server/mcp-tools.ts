import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getBotPolicy } from "@/features/settings/server/service";
import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { getToolContext } from "@/server/mcp/context";

import type { ScheduledTask } from "../types";
import {
  createScheduledTaskService,
  editScheduledTaskService,
  getScheduledTasks,
  getTask,
  removeScheduledTaskService,
  summarizeTask,
} from "./service";

/**
 * Scheduled tasks exposed as MCP tools, so the bot can set up, list, and cancel
 * reminders conversationally. The chat is bound per turn via the tool context, so
 * every tool operates only on the *current* chat's tasks — the model never passes
 * (or picks) a chat id, and can't reach another chat's tasks.
 *
 * Per the recorded decision these are **not owner-gated** — any chat participant
 * may create tasks (unlike the MVP, which restricted them to the owner). But a
 * task has an **author** (`createdByUserId`), and a participant may only
 * **edit/cancel tasks they created** — you cannot change or cancel someone else's
 * task. Listing/reading show all of the chat's tasks (with their author) so the
 * model can see what exists; only the mutations are author-scoped. Deliveries go
 * to the chat the task belongs to.
 *
 * The **owner is exempt from the author rule** (user decision, 2026-08-07) and may
 * edit or cancel any task in a chat they are in — including the ones with no
 * author at all, created from the dashboard, which until now nobody could touch
 * from chat. Chat scoping is not part of the exemption: the owner reaches only
 * the current chat's tasks, like everyone else, because `chatId` is bound by the
 * tool context and never passed by the model.
 */

export const TASKS_CREATE_TOOL = "tasks_create";
export const TASKS_UPDATE_TOOL = "tasks_update";
export const TASKS_DELETE_TOOL = "tasks_delete";
export const TASKS_LIST_TOOL = "tasks_list";
export const TASKS_GET_TOOL = "tasks_get";

export const SCHEDULED_TASKS_TOOL_NAMES = [
  TASKS_CREATE_TOOL,
  TASKS_UPDATE_TOOL,
  TASKS_DELETE_TOOL,
  TASKS_LIST_TOOL,
  TASKS_GET_TOOL,
];

const scheduleKind = z.enum(["once", "daily", "weekly"]);

/** Structured view of a task returned alongside the text confirmation. */
function taskView(task: ScheduledTask) {
  return {
    id: task.id,
    instruction: task.instruction,
    context: task.context,
    schedule_kind: task.scheduleKind,
    time: task.timeOfDay,
    weekdays: task.weekdays,
    run_date: task.runDate,
    enabled: task.enabled,
    next_run_at: task.nextRunAt,
    created_by_user_id: task.createdByUserId,
    summary: summarizeTask(task),
  };
}

/** Task ids are `randomUUID()` values; anything else never existed. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` even has the shape of a task id. */
export function isTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id.trim());
}

/**
 * The message for an id that matched no task in this chat.
 *
 * Written against a production failure (2026-08-05): the model copied an id from
 * `tasks_list` with one character dropped, and the old answer — "No task <id> in
 * this chat." — was the same sentence for a mistyped id, a deleted task, and
 * another chat's task. Its reasoning shows it concluded the task had vanished
 * between the two calls, since nothing in the reply said otherwise. So say which
 * case this is, and hand back the ids to copy from: the loop still has rounds
 * left, and the model can only use them if the error tells it what to fix. The
 * ids are the chat's own, already listed by `tasks_list`.
 */
export function unknownTaskText(id: string, knownIds: string[]): string {
  const shape = isTaskId(id)
    ? ""
    : " That is not a valid task id: ids are 36-character UUIDs, so this one was truncated or mistyped when copied.";
  const known =
    knownIds.length > 0
      ? ` Task ids in this chat: ${knownIds.join(", ")}. Copy one exactly, character for character.`
      : " This chat has no scheduled tasks.";
  return `No task ${id} in this chat.${shape}${known}`;
}

/**
 * Whether the current participant may edit/cancel this task: it must belong to
 * this chat and have been created by them — or the turn must carry the owner's
 * rights. Returns an error result to relay when not, else null. `knownIds` are
 * this chat's task ids, used only to explain a miss (see
 * {@link unknownTaskText}). Exported for unit testing the author rule.
 *
 * The chat check comes first and the owner does **not** pass it: `chatId` is the
 * boundary the tool context binds, and no rights reach across it. What the owner
 * is exempt from is the author rule inside their own chat.
 */
export function checkOwnership(
  task: ScheduledTask | null,
  ctx: { chatId: string; userId?: string | null; isOwner?: boolean },
  id: string,
  knownIds: string[] = [],
): ReturnType<typeof errorResult> | null {
  if (!task || task.chatId !== ctx.chatId) return errorResult(unknownTaskText(id, knownIds));
  if (ctx.isOwner) return null;
  if (!ctx.userId || task.createdByUserId !== ctx.userId) {
    return errorResult(
      `Task ${id} was created by someone else — you can only change tasks you created. ` +
        `Only the bot's owner can change or cancel another person's task.`,
    );
  }
  return null;
}

/** This chat's task ids, in `tasks_list` order — only loaded to explain a miss. */
async function chatTaskIds(chatId: string): Promise<string[]> {
  return (await getScheduledTasks(chatId)).map((task) => task.id);
}

/**
 * Resolve the task a mutating tool named, or the error result to relay: the miss
 * and author rules for `tasks_update`/`tasks_delete` in one place.
 *
 * Owner status is read from the turn's **authority** — the sender normally, the
 * author of the standing chat rule when a rule drove the turn — the same
 * resolution `browse_web` uses, and the one `McpToolContext.authorityUserId`
 * documents. Provenance is untouched: the task's `createdByUserId` still records
 * whoever really created it. A settings read the policy calls cheap enough to run
 * per message, so it is resolved plainly rather than only on the deny path.
 *
 * Best-effort, and it fails **closed**: an unreadable policy means no owner is
 * recognized, so the author rule stands. Widening rights on a failed read is the
 * one outcome a permission check must never have.
 */
async function guardMutation(
  id: string,
  ctx: { chatId: string; userId?: string | null; authorityUserId?: string | null },
): Promise<ReturnType<typeof errorResult> | null> {
  const task = await getTask(id);
  const found = task != null && task.chatId === ctx.chatId;
  const policy = await getBotPolicy().catch(() => null);
  const authority = ctx.authorityUserId ?? ctx.userId;
  const isOwner = Boolean(policy?.ownerUserId && authority === policy.ownerUserId);
  return checkOwnership(task, { ...ctx, isOwner }, id, found ? [] : await chatTaskIds(ctx.chatId));
}

/**
 * A task as text for the tools, with the saved context spelled out.
 * {@link summarizeTask} is the shared one-liner (dashboard, fire logs); a model
 * deciding whether it still has background to gather has to be able to see
 * whether the task carries any — otherwise "context" is invisible until it
 * fires blind.
 */
function taskText(task: ScheduledTask): string {
  return `${summarizeTask(task)}\ncontext: ${task.context ?? "(none saved)"}`;
}

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Map an ApiError (validation/not-found) to a tool error the model can relay. */
function toToolError(err: unknown): { content: { type: "text"; text: string }[]; isError: true } | null {
  if (err instanceof ApiError) return errorResult(err.message);
  return null;
}

/** The trigger for a task mutation traced from a chat turn. */
function toolTrigger(chatId: string, userId?: string | null): TraceTrigger {
  return { kind: "telegram", actor: userId ?? chatId, correlationId: chatId };
}

/** Register the scheduled-tasks MCP tools on the shared server. */
/**
 * `tasks_create`'s description — exported so the behavioural rules it carries can
 * be pinned by tests. Two of them are load-bearing and were each written against
 * a production failure: third-person/joke phrasings still being schedule requests
 * (2026-07-27), and the task having to carry its own facts because a fire gets no
 * transcript (2026-07-28 — a "remind him who X is" task fired as exactly that
 * sentence, since the firing model had never seen X mentioned). The dedicated
 * `context` field is the rework of that second rule (2026-07-31): asking for the
 * facts to be woven into the instruction still produced one-liners, so gathering
 * context is now a required input of its own.
 */
export const TASKS_CREATE_DESCRIPTION =
  "Schedule a task for THIS chat — a reminder/nudge the bot delivers at a set time. Use " +
  "whenever a user asks to be reminded or to have something happen later or on a schedule, " +
  "including one-off and relative requests like 'remind me in 5 minutes', 'in an hour', " +
  "'tonight', or 'tomorrow at 9'. This includes playful or in-character requests, and ones " +
  "phrased in the third person about the bot ('let <bot name> roast everyone once a day') — " +
  "a recurring bit or gag is still a schedule request: create the task, then answer in " +
  "character. Resolve any relative/named time against the current " +
  "date/time given in context, then pass a concrete time. " +
  "IMPORTANT — when the task fires you will have ONLY the stored 'instruction' and " +
  "'context' texts: no chat transcript, no conversation memory. So GATHER CONTEXT BEFORE " +
  "CREATING: if the request points at a person, event, joke, or topic from this chat " +
  "rather than spelling it out, collect what it actually refers to — from the messages " +
  "you can already see, or by searching the conversation history (history_search, then " +
  "history_get_in_range around the matches if the matches alone are thin) — and save it " +
  "in 'context'. 'Remind Kyrylo who X is' with no context is worthless at fire time; the " +
  "same instruction with context 'X is <who they are and why it came up>' works. If you " +
  "cannot find what it refers to, ask the user what it refers to instead of storing the " +
  "empty phrasing. " +
  "Times are in the operator timezone. schedule_kind: once=a single " +
  "run (give 'date' YYYY-MM-DD + 'time'); daily=every day at 'time'; weekly=given " +
  "'weekdays' at 'time'. For a one-off 'in N minutes/hours' or 'tomorrow' reminder use " +
  "once with the computed date and HH:MM time.";

/**
 * `tasks_update`'s description — exported for pinning like the create one, and
 * carrying the same gather-context rule for the same reason (2026-08-01). The
 * rule lived only on `tasks_create`, so the one case it most needed to cover
 * went uncovered: a user handing over the background that a thin existing task
 * was missing. The model updated the row with no `context` gathered, and the
 * fire stayed exactly as blind as before.
 */
export const TASKS_UPDATE_DESCRIPTION =
  "Change or enable/disable a task in THIS chat by its id — tasks the current user created, " +
  "and any task in this chat when the current user is the bot's owner. Just call it: the tool " +
  "decides, and answers plainly if the user is not allowed. Only the fields you pass are changed. " +
  "Get the id from tasks_list; tasks_list and tasks_get show each task's saved context. " +
  "IMPORTANT — the same rule as tasks_create: when the task fires you will have ONLY the " +
  "stored 'instruction' and 'context' texts, no chat transcript and no conversation memory. " +
  "So GATHER CONTEXT BEFORE UPDATING whenever the update touches what the task is about — " +
  "the user telling you what a task's person/event/joke/topic actually is IS such an update, " +
  "and so is changing the instruction to point at something from this chat. Collect what it " +
  "refers to from the messages you can already see, or by searching the conversation history " +
  "(history_search, then history_get_in_range around the matches if the matches alone are " +
  "thin), and pass it as 'context'. Changing the instruction while leaving context describing " +
  "the old one is worse than leaving both alone. Updating only the time, schedule or 'enabled' " +
  "needs no context. Times are in the operator timezone.";

export function registerScheduledTasksMcpTools(server: McpServer): void {
  server.registerTool(
    TASKS_CREATE_TOOL,
    {
      title: "Create scheduled task",
      description: TASKS_CREATE_DESCRIPTION,
      inputSchema: {
        instruction: z
          .string()
          .min(2)
          .describe(
            "What the task should do when it fires — a directive like 'remind Kyrylo about " +
              "topic X'. Put the background facts it relies on into 'context', not here.",
          ),
        context: z
          .string()
          .describe(
            "The gathered background the fire will need: what the instruction's references " +
              "(people, events, jokes, topics) actually are, written self-contained for a " +
              "reader with NO chat transcript. Collect it from the visible conversation or " +
              "history search BEFORE creating the task. Pass '' ONLY when the instruction is " +
              "fully self-contained (e.g. 'remind me to drink water').",
          ),
        schedule_kind: scheduleKind.describe("once, daily, or weekly"),
        time: z.string().describe("Local time of day as HH:MM (24-hour)"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .default([])
          .describe("Weekdays for 'weekly' (0=Sunday..6=Saturday)"),
        date: z.string().default("").describe("Date for 'once' as YYYY-MM-DD"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ instruction, context, schedule_kind, time, weekdays, date }) => {
      const ctx = getToolContext();
      try {
        const task = await createScheduledTaskService(
          {
            chatId: ctx.chatId,
            threadId: ctx.threadId ?? null,
            createdByUserId: ctx.userId ?? null,
            instruction,
            context,
            scheduleKind: schedule_kind,
            timeOfDay: time,
            weekdays: weekdays ?? [],
            runDate: date.trim() ? date.trim() : null,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        return textResult(`Task created: ${taskText(task)}`, { ok: true, task: taskView(task) });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    TASKS_UPDATE_TOOL,
    {
      title: "Update scheduled task",
      description: TASKS_UPDATE_DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe("Task id to update (from tasks_list)"),
        instruction: z
          .string()
          .default("")
          .describe(
            "New instruction (optional) — a directive; background facts go in 'context'. If it " +
              "now refers to a person, event, joke or topic from this chat, pass 'context' too.",
          ),
        context: z
          .string()
          .default("")
          .describe(
            "New saved background (optional) — the gathered facts the fire will need, written " +
              "self-contained for a reader with NO chat transcript. Pass it whenever the user " +
              "supplies background for this task or you change what the instruction refers to; " +
              "gather it from the visible conversation or history search first. Replaces the " +
              "stored context entirely; '' leaves it unchanged.",
          ),
        schedule_kind: z.enum(["once", "daily", "weekly", ""]).default("").describe("New schedule kind (optional)"),
        time: z.string().default("").describe("New time HH:MM (optional)"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .default([])
          .describe("New weekdays for 'weekly' (optional)"),
        date: z.string().default("").describe("New date YYYY-MM-DD for 'once' (optional)"),
        enabled: z.boolean().nullable().default(null).describe("Enable or disable (optional)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, instruction, context, schedule_kind, time, weekdays, date, enabled }) => {
      const ctx = getToolContext();
      const denied = await guardMutation(id, ctx);
      if (denied) return denied;
      try {
        const task = await editScheduledTaskService(
          id,
          {
            instruction: instruction.trim() ? instruction.trim() : undefined,
            context: context.trim() ? context.trim() : undefined,
            scheduleKind: schedule_kind ? schedule_kind : undefined,
            timeOfDay: time.trim() ? time.trim() : undefined,
            weekdays: weekdays.length > 0 ? weekdays : undefined,
            runDate: date.trim() ? date.trim() : undefined,
            enabled: enabled === null ? undefined : enabled,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        return textResult(`Task updated: ${taskText(task)}`, { ok: true, task: taskView(task) });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  server.registerTool(
    TASKS_DELETE_TOOL,
    {
      title: "Cancel scheduled task",
      description:
        "Cancel (delete) a task in THIS chat by its id — tasks the current user created, and " +
        "any task in this chat when the current user is the bot's owner. Just call it: the tool " +
        "decides, and answers plainly if the user is not allowed, so never refuse on their " +
        "behalf or guess at who created a task. Get the id from tasks_list.",
      inputSchema: { id: z.string().min(1).describe("Task id to cancel (from tasks_list)") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const ctx = getToolContext();
      const denied = await guardMutation(id, ctx);
      if (denied) return denied;
      await removeScheduledTaskService(id, toolTrigger(ctx.chatId, ctx.userId));
      return textResult(`Task ${id} cancelled.`, { ok: true, id });
    },
  );

  server.registerTool(
    TASKS_LIST_TOOL,
    {
      title: "List scheduled tasks",
      description: "List the scheduled tasks for THIS chat, with their ids, schedules, and next run times.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const ctx = getToolContext();
      const tasks = await getScheduledTasks(ctx.chatId);
      const text =
        tasks.length === 0
          ? "(no scheduled tasks in this chat)"
          : tasks
              .map(
                (t) =>
                  `${t.id}: ${summarizeTask(t)}${t.context ? "" : " [no saved context — a fire sees nothing else]"}`,
              )
              .join("\n");
      return textResult(text, { ok: true, count: tasks.length, tasks: tasks.map(taskView) });
    },
  );

  server.registerTool(
    TASKS_GET_TOOL,
    {
      title: "Get scheduled task",
      description:
        "Read one task in THIS chat by its id, including the background saved with it. Read it " +
        "before changing what a task is about, so you can tell whether its context still fits.",
      inputSchema: { id: z.string().min(1).describe("Task id to read (from tasks_list)") },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const ctx = getToolContext();
      const task = await getTask(id);
      if (!task || task.chatId !== ctx.chatId) {
        return errorResult(unknownTaskText(id, await chatTaskIds(ctx.chatId)));
      }
      return textResult(taskText(task), { ok: true, task: taskView(task) });
    },
  );
}
