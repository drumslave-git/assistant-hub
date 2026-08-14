import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { ApiError } from "@/lib/api-error";
import type { TraceTrigger } from "@/lib/trace";
import { getToolContext } from "@/server/mcp/context";

import { describeTrigger } from "../schedule";
import { isPromptTask, type Task, type TriggerKind } from "../types";
import { MAX_INSTRUCTION_LENGTH, MAX_TASK_TARGETS } from "./schema";
import {
  createTaskFromChat,
  deleteTaskFromChat,
  getChatVisibleTask,
  getChatVisibleTasks,
  summarizeTask,
  updateTaskFromChat,
  type TaskWriteResult,
} from "./service";

/**
 * The tasks toolkit, exposed as MCP tools: how the people in a chat give the
 * bot work — a standing rule ("from now on, whenever X, do Y"), a reminder
 * ("remind me in an hour"), a recurring job ("every morning, check X") — and
 * manage what they already gave it, in their own words, without the dashboard.
 *
 * The chat is bound per turn via the tool context, so a task can only ever be
 * written for the current conversation. Who may write is enforced **inside**
 * the service (no lexical pre-filter): standing (`message`/`on-reply`) tasks
 * are self-serve in a private chat and owner-only in a group; timed tasks are
 * open to create and creator-or-owner to change. A denied caller gets a refusal
 * the model relays. Global tasks are visible here and editable only in the
 * dashboard.
 *
 * Every read here goes through the service's chat-visible functions, so a
 * **paused** task simply is not in this toolkit's world: it cannot be listed,
 * read, changed or deleted, and there is no way to pause one from a chat —
 * cancelling means deleting (user decision, 2026-08-14).
 */

export const TASKS_LIST_TOOL = "tasks_list";
export const TASKS_GET_TOOL = "tasks_get";
export const TASKS_CREATE_TOOL = "tasks_create";
export const TASKS_UPDATE_TOOL = "tasks_update";
export const TASKS_DELETE_TOOL = "tasks_delete";

export const TASKS_TOOL_NAMES = [
  TASKS_LIST_TOOL,
  TASKS_GET_TOOL,
  TASKS_CREATE_TOOL,
  TASKS_UPDATE_TOOL,
  TASKS_DELETE_TOOL,
];

/**
 * What `tasks_create` has to teach a small model, kept as a constant so the
 * live tool-selection test can pin it. It carries every behavioural rule its
 * two predecessors (`rules_create`, the scheduled `tasks_create`) earned in
 * production, because the failures they answered do not care that the tools
 * merged:
 *
 * 1. Recognize the many phrasings of both a standing rule (few users say
 *    "rule") and a schedule request (playful/third-person ones included).
 * 2. Separate it from the neighbouring tool it is confused with: a fact about
 *    a person is memory. (The old rules/tasks confusion is gone — they are one
 *    tool now, distinguished by `trigger`.)
 * 3. Pick the trigger from what the person actually described: WHO/WHAT
 *    triggers it (message), a bare style instruction (on-reply), "every N"
 *    (interval), "in N" (timeout), or clock/calendar times (schedule).
 * 4. The repeat-is-safe rules (trace `f33e1ede…`, 2026-07-29): its own past
 *    "got it" is not the task being saved; a repeated instruction means the
 *    person does not believe it took effect; `tasks_list` is the only evidence.
 * 5. Gather context before creating a timed task (2026-07-28): a fire sees no
 *    transcript, so pointers must be resolved into `context` first.
 * 6. Audience ids are copied from the roster, never invented (2026-08-13).
 */
export const TASKS_CREATE_DESCRIPTION =
  "Save a task for THIS chat — either a STANDING RULE about how you must behave here from now " +
  "on, or a TIMED job (a reminder or something recurring) that runs by itself later. Use it " +
  "whenever someone sets one up, however they phrase it: \"new rule: …\", \"from now on …\", " +
  "\"always …\", \"never … again\", \"whenever someone sends X, do Y\", \"stop doing X\", " +
  "\"remind me in 5 minutes / tonight / tomorrow at 9\", \"every day at 8, …\", \"every 10 " +
  "minutes, check …\" — including playful or third-person requests about you ('let the bot " +
  "roast everyone once a day'): a recurring bit is still a task. This is NOT for facts about " +
  "people — that is the memory tool. " +
  "Write the instruction as a complete, self-contained directive to yourself, spelling out the " +
  "trigger and the action in full — it is read later without this conversation. " +
  "Pick 'trigger' from what was described: " +
  "'message' when something people SAY or POST here must set it off, even when nobody is " +
  "talking to you (\"any time someone posts X, do Y\"); " +
  "'on-reply' when it only shapes how you answer people who talk to you (\"answer briefly\"); " +
  "'interval' with every_minutes for \"every N minutes/hours/days\"; " +
  "'timeout' with delay_minutes for one-off relative requests — \"in 5 minutes\" is " +
  "delay_minutes 5, \"in two hours\" is 120; " +
  "'schedule' with time (HH:MM, operator timezone) plus date (YYYY-MM-DD, a single run) or " +
  "weekdays (0=Sunday..6=Saturday) or neither (daily) for clock-and-calendar requests. " +
  "IMPORTANT for timed tasks — when the task fires you will have ONLY the stored 'instruction' " +
  "and 'context' texts: no chat transcript, no conversation memory. So GATHER CONTEXT BEFORE " +
  "CREATING: if the request points at a person, event, joke, or topic from this chat rather " +
  "than spelling it out, collect what it actually refers to (from the visible messages, or " +
  "history_search then history_get_in_range around thin matches) and save it in 'context'; if " +
  "you cannot find it, ask instead of storing the empty phrasing. " +
  "A standing rule applies to everyone in the chat, which is what almost every rule wants. In " +
  "a group you can instead limit it to particular people with user_ids, and only when the " +
  "instruction is explicitly about them — then it acts on their messages and nobody else's. " +
  "Copy each id exactly from the group participant list you were given: never invent one, " +
  "never work one out from a name, and if the person is not listed, say so instead of guessing. " +
  "ALWAYS call this tool when a task is set, even if the conversation already contains you " +
  "saying you would do it: a message of yours agreeing is NOT the task being saved, and a task " +
  "never stored through this tool does not exist no matter how often you promised it. Someone " +
  "repeating the same instruction is telling you they do not believe it took effect — call the " +
  "tool, do not reassure them again. Calling it twice is safe: a standing rule that is already " +
  "there is left exactly as it is and the result says so. If you want to know what is actually " +
  "stored, call tasks_list — that result is the only evidence; your own earlier messages are " +
  "not. Tell the person what you saved once it is stored.";

/**
 * `tasks_update`'s description — pinned like the create one, and carrying the
 * same gather-context rule for the same reason (2026-08-01): the case it most
 * needs to cover is a user handing over the background a thin existing task was
 * missing.
 */
export const TASKS_UPDATE_DESCRIPTION =
  "Change one of THIS chat's tasks by its id — reword it, change when or how it triggers, or " +
  "change who a standing rule applies to. Use it when someone amends a task they already set " +
  "rather than adding a new one. It cannot switch a task off: when someone cancels, stops or " +
  "calls off a task, that task is deleted, not changed here. Just call it: the tool decides who " +
  "is allowed and answers plainly when the caller is not, so never refuse on its behalf. Get " +
  "the id from tasks_list; only the fields you pass are changed. " +
  "IMPORTANT for timed tasks — the same rule as tasks_create: a fire sees ONLY the stored " +
  "'instruction' and 'context'. When the update touches what the task is about — including the " +
  "user telling you what a task's person/event/joke/topic actually is — gather the background " +
  "(visible messages, or history search) and pass it as 'context'; it replaces the stored " +
  "context entirely. Changing only the timing needs no context. " +
  "Times are in the operator timezone.";

function textResult(text: string, structured?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent: structured };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

/** Map an ApiError (cap, duplicate, bad trigger, unknown id) to a tool error. */
function toToolError(err: unknown): ReturnType<typeof errorResult> | null {
  if (err instanceof ApiError) return errorResult(err.message);
  return null;
}

/** The trigger for a task mutation traced from a chat turn. */
function toolTrigger(chatId: string, userId?: string | null): TraceTrigger {
  return { kind: "telegram", actor: userId ?? chatId, correlationId: chatId };
}

/**
 * Structured view of a task returned alongside the text result. It carries no
 * `enabled`: every task a chat is shown is in force, and a field that is always
 * true only invites the model to reason about a state it cannot reach.
 */
function taskView(task: Task) {
  return {
    id: task.id,
    instruction: task.instruction,
    context: task.context,
    trigger: task.triggerKind,
    every_minutes: task.everyMinutes,
    delay_minutes: task.delayMinutes,
    time: task.timeOfDay,
    weekdays: task.weekdays,
    run_date: task.runDate,
    scope: task.chatId === null ? "global" : "this_chat",
    applies_to: task.targetUserIds.length > 0 ? task.targetUserIds : "everyone",
    next_run_at: task.nextRunAt,
    created_by_user_id: task.createdByUserId,
    summary: summarizeTask(task),
  };
}

/** A task's audience as a phrase that completes "it applies …". */
function audienceText(task: Task): string {
  if (task.targetUserIds.length === 0) return "to everyone here";
  return `only to messages from user ${task.targetUserIds.join(", ")}`;
}

/** One task as a compact line the model can read back to the chat. */
function taskLine(task: Task): string {
  const flags = [describeTrigger(task)];
  if (task.chatId === null) flags.push("every chat");
  if (task.targetUserIds.length > 0) flags.push(`only for user ${task.targetUserIds.join(", ")}`);
  const noContext =
    !isPromptTask(task) && !task.context ? " [no saved context — a fire sees nothing else]" : "";
  return `${task.id} [${flags.join(", ")}]: ${task.instruction}${noContext}`;
}

/** Task ids are `randomUUID()` values; anything else never existed. */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The message for an id that matched no task in this chat. Written against a
 * production failure (2026-08-05): the model copied an id from `tasks_list`
 * with one character dropped, and the old one-sentence answer read as "the task
 * vanished". Say which case this is, and hand back the ids to copy from.
 */
export function unknownTaskText(id: string, knownIds: string[]): string {
  const shape = TASK_ID_PATTERN.test(id.trim())
    ? ""
    : " That is not a valid task id: ids are 36-character UUIDs, so this one was truncated or mistyped when copied.";
  const known =
    knownIds.length > 0
      ? ` Task ids in this chat: ${knownIds.join(", ")}. Copy one exactly, character for character.`
      : " This chat has no tasks.";
  return `No task ${id} in this chat.${shape}${known}`;
}

/** Relay a chat-side write outcome, or null when it succeeded. */
async function relayFailure(
  result: TaskWriteResult,
  chatId: string,
  id?: string,
): Promise<ReturnType<typeof errorResult> | null> {
  if (result.status === "denied") return errorResult(result.reason);
  if (result.status === "not_found") {
    const known = (await getChatVisibleTasks(chatId).catch(() => []))
      .filter((task) => task.chatId !== null)
      .map((task) => task.id);
    return errorResult(unknownTaskText(id ?? "?", known));
  }
  return null;
}

/** Register the tasks MCP tools on the shared server. */
export function registerTasksMcpTools(server: McpServer): void {
  server.registerTool(
    TASKS_LIST_TOOL,
    {
      title: "List tasks",
      description:
        "List THIS chat's tasks with their ids — standing rules (with whose messages each " +
        "applies to), reminders, and recurring jobs, plus any the operator set for every chat. " +
        "Use it when someone asks what rules or tasks you have, what you were told to do, or " +
        "before changing or removing one (you need its id). Tasks marked as applying to every " +
        "chat cannot be changed from here.",
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
      const tasks = await getChatVisibleTasks(ctx.chatId);
      const text =
        tasks.length === 0 ? "(no tasks are set for this chat)" : tasks.map(taskLine).join("\n");
      return textResult(text, { ok: true, count: tasks.length, tasks: tasks.map(taskView) });
    },
  );

  server.registerTool(
    TASKS_GET_TOOL,
    {
      title: "Get task",
      description:
        "Read one of THIS chat's tasks by its id, including the background saved with it. Read " +
        "it before changing what a task is about, so you can tell whether its context still fits.",
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
      const task = await getChatVisibleTask(id, ctx.chatId);
      if (!task) {
        const known = (await getChatVisibleTasks(ctx.chatId))
          .filter((t) => t.chatId !== null)
          .map((t) => t.id);
        return errorResult(unknownTaskText(id, known));
      }
      return textResult(`${taskLine(task)}\ncontext: ${task.context ?? "(none saved)"}`, {
        ok: true,
        task: taskView(task),
      });
    },
  );

  server.registerTool(
    TASKS_CREATE_TOOL,
    {
      title: "Create task",
      description: TASKS_CREATE_DESCRIPTION,
      inputSchema: {
        instruction: z
          .string()
          .min(2)
          .max(MAX_INSTRUCTION_LENGTH)
          .describe(
            "The task as a complete instruction to yourself, naming both what triggers it and " +
              "what you must do — understandable on its own, without this conversation. " +
              "Background facts go in 'context', not here",
          ),
        trigger: z
          .enum(["message", "on-reply", "interval", "timeout", "schedule"])
          .describe(
            "'message' when things people say/post must set it off; 'on-reply' when it only " +
              "shapes your answers; 'interval' for every-N-minutes; 'timeout' for a one-off " +
              "delay from now; 'schedule' for clock/calendar times",
          ),
        context: z
          .string()
          .default("")
          .describe(
            "Timed tasks: the gathered background the fire will need, self-contained for a " +
              "reader with NO chat transcript. Pass '' when the instruction is fully " +
              "self-contained, and always for standing rules",
          ),
        user_ids: z
          .array(z.string().min(1))
          .max(MAX_TASK_TARGETS)
          .default([])
          .describe(
            "Group standing rules only: the user ids, copied exactly from the participant " +
              "list, of the people the rule is about — it then applies to their messages and " +
              "no one else's. Leave empty for a rule that applies to everyone (the normal case)",
          ),
        every_minutes: z
          .number()
          .int()
          .default(0)
          .describe("'interval' only: minutes between runs (every 10m = 10, hourly = 60)"),
        delay_minutes: z
          .number()
          .int()
          .default(0)
          .describe("'timeout' only: minutes from now until the single run (in 1h = 60)"),
        time: z.string().default("").describe("'schedule' only: local time of day as HH:MM (24-hour)"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .default([])
          .describe("'schedule' only: weekdays for a weekly run (0=Sunday..6=Saturday)"),
        date: z.string().default("").describe("'schedule' only: date for a single run as YYYY-MM-DD"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ instruction, trigger, context, user_ids, every_minutes, delay_minutes, time, weekdays, date }) => {
      const ctx = getToolContext();
      try {
        const result = await createTaskFromChat(
          {
            chatId: ctx.chatId,
            userId: ctx.userId ?? null,
            threadId: ctx.threadId ?? null,
            instruction: instruction.trim(),
            context: context.trim() ? context.trim() : null,
            triggerKind: trigger as TriggerKind,
            targetUserIds: user_ids,
            everyMinutes: every_minutes > 0 ? every_minutes : null,
            delayMinutes: delay_minutes > 0 ? delay_minutes : null,
            timeOfDay: time.trim() ? time.trim() : null,
            weekdays: weekdays.length > 0 ? weekdays : null,
            runDate: date.trim() ? date.trim() : null,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = await relayFailure(result, ctx.chatId);
        if (failure) return failure;
        // A repeat is a success, not a conflict — the asked-for state is in force.
        if (result.status === "exists") {
          return textResult(
            `That rule is already in force for this chat (${describeTrigger(result.task)}), ` +
              `unchanged: ${result.task.instruction}`,
            { ok: true, task: taskView(result.task), already_present: true },
          );
        }
        // The same standing rule asked for with a different set of people: the
        // rule stays, its audience is what changed.
        if (result.status === "updated") {
          return textResult(
            `That rule was already set here; it now applies ${audienceText(result.task)}: ` +
              `${result.task.instruction}`,
            { ok: true, task: taskView(result.task) },
          );
        }
        if (result.status !== "created") return errorResult("The task could not be saved.");
        const audience = isPromptTask(result.task) ? `, applies ${audienceText(result.task)}` : "";
        return textResult(
          `Task saved for this chat (${describeTrigger(result.task)}${audience}): ` +
            `${result.task.instruction}` +
            (result.task.nextRunAt ? `\nNext run: ${result.task.nextRunAt}` : ""),
          { ok: true, task: taskView(result.task) },
        );
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
      title: "Update task",
      description: TASKS_UPDATE_DESCRIPTION,
      inputSchema: {
        id: z.string().min(1).describe("Task id to change (from tasks_list)"),
        instruction: z
          .string()
          .max(MAX_INSTRUCTION_LENGTH)
          .default("")
          .describe("New instruction, complete and self-contained (leave empty to keep it)"),
        context: z
          .string()
          .default("")
          .describe(
            "Timed tasks: new saved background, self-contained for a reader with NO chat " +
              "transcript; replaces the stored context entirely. '' leaves it unchanged",
          ),
        // Optional-by-omission, not an "" enum member: Google's OpenAI-compat
        // layer rejects empty enum values ("enum[N]: cannot be empty").
        trigger: z
          .enum(["message", "on-reply", "interval", "timeout", "schedule"])
          .optional()
          .describe("New trigger kind (optional; omit to keep it)"),
        // No `enabled`: pausing is the operator's, done in the dashboard, and a
        // cancellation from chat is a deletion (user decision, 2026-08-14).
        // Two fields rather than one nullable list, for the same reason `text`
        // keeps its value on "": an empty array is what a model sends when it
        // means "leave this alone", and reading that as "everyone" would
        // quietly widen a rule that was written about one person.
        user_ids: z
          .array(z.string().min(1))
          .max(MAX_TASK_TARGETS)
          .default([])
          .describe(
            "Group standing rules only: the complete new list of user ids the rule applies " +
              "to, copied exactly from the participant list (replaces the current list). " +
              "Leave empty to leave the audience exactly as it is",
          ),
        applies_to_everyone: z
          .boolean()
          .nullable()
          .default(null)
          .describe(
            "true to drop any limit to particular people, so the rule applies to everyone in " +
              "the chat again (optional)",
          ),
        every_minutes: z
          .number()
          .int()
          .default(0)
          .describe("'interval': new minutes between runs (0 keeps it)"),
        delay_minutes: z
          .number()
          .int()
          .default(0)
          .describe("'timeout': new minutes from now until the run (0 keeps it; re-arms from now)"),
        time: z.string().default("").describe("'schedule': new time HH:MM ('' keeps it)"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .default([])
          .describe("'schedule': new weekdays (empty keeps them)"),
        date: z.string().default("").describe("'schedule': new date YYYY-MM-DD ('' keeps it)"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      id,
      instruction,
      context,
      trigger,
      user_ids,
      applies_to_everyone,
      every_minutes,
      delay_minutes,
      time,
      weekdays,
      date,
    }) => {
      const ctx = getToolContext();
      // Clearing the audience wins over naming people: asking for both is
      // contradictory, and "everyone" is the request that cannot be a mistake.
      const targets = applies_to_everyone === true ? [] : (user_ids ?? []);
      const patch = {
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        ...(context.trim() ? { context: context.trim() } : {}),
        ...(trigger ? { triggerKind: trigger as TriggerKind } : {}),
        ...(applies_to_everyone === true || targets.length > 0
          ? { targetUserIds: targets }
          : {}),
        ...(every_minutes > 0 ? { everyMinutes: every_minutes } : {}),
        ...(delay_minutes > 0 ? { delayMinutes: delay_minutes } : {}),
        ...(time.trim() ? { timeOfDay: time.trim() } : {}),
        ...(weekdays.length > 0 ? { weekdays } : {}),
        ...(date.trim() ? { runDate: date.trim() } : {}),
      };
      if (Object.keys(patch).length === 0) {
        return errorResult(
          "Nothing to change — pass new text, a new trigger or timing, or who the rule applies " +
            "to. To cancel the task instead, delete it.",
        );
      }
      try {
        const result = await updateTaskFromChat(
          {
            chatId: ctx.chatId,
            userId: ctx.userId ?? null,
            authorityUserId: ctx.authorityUserId ?? null,
            id,
            patch,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = await relayFailure(result, ctx.chatId, id);
        if (failure) return failure;
        if (result.status !== "updated") return errorResult("The task could not be changed.");
        const audience = isPromptTask(result.task)
          ? `, applies ${audienceText(result.task)}`
          : "";
        return textResult(
          `Task updated (${describeTrigger(result.task)}${audience}): ` +
            `${result.task.instruction}` +
            (result.task.nextRunAt ? `\nNext run: ${result.task.nextRunAt}` : ""),
          { ok: true, task: taskView(result.task) },
        );
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
      title: "Delete task",
      description:
        "Remove one of THIS chat's tasks for good by its id. This is how a task is cancelled " +
        "here — there is no pausing from a chat, so any request to cancel, stop, call off or " +
        "undo a rule or a reminder (\"forget that rule\", \"cancel that reminder\", \"stop " +
        "doing that\", \"you can drop that one now\") means deleting it. Just call it: the tool " +
        "decides who is allowed and answers plainly when the caller is not. List the tasks " +
        "first to get the id.",
      inputSchema: { id: z.string().min(1).describe("Task id to delete (from tasks_list)") },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const ctx = getToolContext();
      try {
        const result = await deleteTaskFromChat(
          {
            chatId: ctx.chatId,
            userId: ctx.userId ?? null,
            authorityUserId: ctx.authorityUserId ?? null,
            id,
          },
          toolTrigger(ctx.chatId, ctx.userId),
        );
        const failure = await relayFailure(result, ctx.chatId, id);
        if (failure) return failure;
        return textResult(`Task ${id} deleted — it no longer applies here.`, { ok: true, id });
      } catch (err) {
        const mapped = toToolError(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  );
}
