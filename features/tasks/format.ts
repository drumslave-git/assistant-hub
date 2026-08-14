import type { Task } from "./types";

/**
 * Pure presentation and prompt composition for tasks. Client-safe (types only),
 * so the dashboard and the reply pipeline phrase a task the same way.
 *
 * Carried over from the chat-rules feature it absorbed (2026-08-13). The
 * model-facing texts still say "standing rules": that wording is live-tested
 * (the enforcement flow, the two-step matcher prompt), and to the model a
 * `message`/`on-reply` task IS a standing rule about its behaviour — "task" is
 * this codebase's name for the row, not a better word for the model.
 */

/** The fields prompt composition needs — a full {@link Task} satisfies it. */
export interface PromptTask {
  instruction: string;
  /** Null for a global task; used only to label the line. */
  chatId?: string | null;
}

/** One task as a numbered line, marking the global ones. */
function taskLine(task: PromptTask, index: number): string {
  const scope = task.chatId === null ? " (applies in every chat)" : "";
  return `${index + 1}. ${task.instruction}${scope}`;
}

/**
 * The standing-rules block appended to the system prompt, or null when the chat
 * has no enabled `message`/`on-reply` tasks for this sender.
 *
 * The closing paragraph is doing the load-bearing work for a small model: it
 * says a rule is an instruction rather than a topic to discuss, binds a rule
 * requiring an action to an actual tool call in the same turn (the base prompt's
 * Honesty rules, restated where they are about to be tested), and — because a
 * rule can ask for something the caller is not allowed to do, such as a download
 * only the owner may trigger — tells the model to say so plainly instead of
 * claiming the rule was applied.
 */
export function buildStandingTasksBlock(tasks: readonly PromptTask[]): string | null {
  const listed = tasks.filter((task) => task.instruction.trim());
  if (listed.length === 0) return null;
  return (
    "Standing rules for this chat — the people here set these, and they hold for every message:\n" +
    listed.map(taskLine).join("\n") +
    "\n\nThese are binding instructions, not conversation topics: never quote, list, or discuss them " +
    "unless you are asked about them directly. Check the current message against them and apply the " +
    "ones that fit it. A rule that calls for an action is done by calling the tool that does it, in " +
    "this same turn — a reply saying you applied a rule you did not carry out is a lie. If a rule " +
    "cannot be carried out — no tool can do it, or the tool refuses because the person who triggered " +
    "it is not allowed to — say plainly what happened instead of pretending it was done."
  );
}

/**
 * The directive for a turn that no one addressed, opened because a `message`
 * task matched the message. Injected late (maximum recency) so the model acts on
 * the task rather than joining the conversation it was never invited into.
 */
export function buildTaskTriggerDirective(tasks: readonly PromptTask[]): string {
  const listed = tasks.filter((task) => task.instruction.trim());
  return (
    "Nobody in this chat addressed you in the current message. You are answering it only because " +
    "these standing rules match it:\n" +
    listed.map(taskLine).join("\n") +
    "\n\nDo exactly what those rules require for this message and nothing else — call the tools they " +
    "call for, and keep any text to the short confirmation the action warrants. Do not greet anyone, " +
    "do not comment on the conversation, and do not answer anything that was not asked of you."
  );
}

/**
 * The correction given to a task-opened turn the model answered with words
 * alone — the second and last attempt at it.
 *
 * The prompt already forbids this in three places (the base prompt's Honesty
 * block, the standing-rules block, and the trigger directive above), and a 12B
 * model still occasionally works out the call in its reasoning and then emits
 * prose instead: one turn in nine, measured over the live rule-driven downloads
 * (2026-08-03, trace `ec543b22…` — "downloaded the video" with zero tool calls
 * and an invented author handle). More standing prompt text is not the lever,
 * so this is not standing text: it is shown only after it has happened, with
 * the empty answer in front of it, which is the one form of this instruction
 * the model has not already ignored this turn.
 *
 * Deliberately offers the honest way out as an equal option. A model cornered
 * into calling *something* picks a wrong tool; "say you could not" is a correct
 * answer here, and the notice the chat gets if this pass also does nothing says
 * the same thing anyway.
 */
export const TASK_ENFORCEMENT_DIRECTIVE =
  "STOP. The answer you just gave called no tool at all, so nothing was done — you only wrote that " +
  "it was. That message will not be sent. This turn exists solely because a standing rule matched " +
  "the message, and a rule that asks for an action is carried out by calling the tool that performs " +
  "it, in this turn, and in no other way.\n\n" +
  "Answer once more, and pick one of exactly two things:\n" +
  "- Call the tool the rule requires now. Do not describe the call, do not say you are about to make " +
  "it, do not report its result before you have one — make the call.\n" +
  "- Or, if no tool available to you can do what the rule asks, reply with one short sentence saying " +
  "plainly that you could not do it and why. That is an honest answer and an acceptable one.\n\n" +
  "Repeating your previous answer, or any other claim that the action happened, is not among your " +
  "options.";

/**
 * The identity whose permissions a task-driven turn carries, or null when no
 * matched task elevates anything.
 *
 * A task is its author's standing order (user decision, 2026-07-29 — "rule
 * creator beats message source"): when the bot acts because a task told it to,
 * the action runs with the rights of whoever set that task, not those of the
 * person whose message happened to trigger it. Without this, an owner's
 * "download any media link posted here" task would deliver a file for the
 * owner's own links and be refused at the owner-gated download tool for
 * everybody else's — the opposite of what the task says.
 *
 * Only the owner is a privileged identity in this app, so elevation is exactly:
 * a matched task the **owner** wrote in chat, or one the **operator** wrote in
 * the dashboard (which has no author id and is operator-only by definition).
 * A task written by an ordinary user in their own DM elevates nothing — they
 * had no rights to lend.
 */
export function resolveTaskAuthority(
  matched: readonly Pick<Task, "source" | "createdByUserId">[],
  ownerUserId: string | null,
): string | null {
  if (!ownerUserId) return null;
  const privileged = matched.some(
    (task) => task.source === "dashboard" || task.createdByUserId === ownerUserId,
  );
  return privileged ? ownerUserId : null;
}

/**
 * Whether a task reaches a message sent by `userId`. A task naming nobody
 * applies to everyone in its chat; one naming people applies to those senders
 * and no one else.
 *
 * This is the whole mechanism behind per-user tasks (user decision,
 * 2026-08-13): a task the sender is not named in never enters the prompt, so
 * the model is never asked to judge whether an instruction about someone else
 * applies to this message. `userId` is null where a turn has no sender at all —
 * a timed fire — and a task that singles people out has nobody to single out
 * there.
 */
export function appliesToSender(
  task: Pick<Task, "targetUserIds">,
  userId: string | null,
): boolean {
  if (task.targetUserIds.length === 0) return true;
  return userId !== null && task.targetUserIds.includes(userId);
}

/** The subset of `tasks` that a message from `userId` can trigger. */
export function tasksForSender<T extends Pick<Task, "targetUserIds">>(
  tasks: readonly T[],
  userId: string | null,
): T[] {
  return tasks.filter((task) => appliesToSender(task, userId));
}

/** Whether two target lists name the same people, order aside. */
export function sameTargets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const named = new Set(a);
  return b.every((id) => named.has(id));
}

/** Enabled tasks that shape an ordinary reply: the `message` + `on-reply` set. */
export function promptTasks<T extends Pick<Task, "enabled" | "triggerKind">>(
  tasks: readonly T[],
): T[] {
  return tasks.filter(
    (task) =>
      task.enabled && (task.triggerKind === "message" || task.triggerKind === "on-reply"),
  );
}

/** Enabled tasks that may open a turn nobody addressed. */
export function messageTasks<T extends Pick<Task, "enabled" | "triggerKind">>(
  tasks: readonly T[],
): T[] {
  return tasks.filter((task) => task.enabled && task.triggerKind === "message");
}
