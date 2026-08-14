import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

/**
 * The LLM half of a `message` task: which of this chat's message-triggered
 * tasks, if any, does the current message trigger?
 *
 * Prompt building and parsing are pure, so the whole decision is unit-testable
 * without a provider. The caller (the Telegram runtime) owns the completion and
 * the trace; this module owns what is asked and how the answer is read.
 *
 * Its answer decides two separate things, which is why it runs on addressed and
 * unaddressed messages alike:
 *  - **whether to answer at all** — a matched `message` task opens a turn nobody
 *    addressed the bot in (the addressing check having already said "not
 *    addressed");
 *  - **whose rights the turn carries** — a matched task lends its author's
 *    permissions to the action it calls for (see `resolveTaskAuthority`), so an
 *    owner's task works on everyone's messages and not only the owner's.
 *
 * Both are things the bot has to earn, so the answer is earned twice over, on
 * the addressing analyzer's pattern: the model names the task by its offered
 * number *and* quotes the part of the message that triggers it, and a match only
 * counts when that quote occurs verbatim in the message. Code checks only what
 * is mechanical (the number is one that was offered, the quote is real);
 * whether the task genuinely applies stays the model's judgment.
 *
 * A task limited to particular people carries its audience *into the prompt*
 * (`if message from <name>: …`), and the sender is named over the message. Both
 * are needed because such a task's condition can be the person rather than
 * anything in the words: without the two names the model is asked "does this
 * message contain what the rule describes" about a rule that describes nothing
 * the message could contain, and correctly answers no (2026-08-13, trace
 * `c08283a8…` — a per-person rule that never fired). The audience filter has
 * already decided the sender qualifies; this is what lets the model see *why*.
 *
 * The system prompt below is live-tuned (2026-08-13) and pinned in both
 * directions by `live-matcher.integration.test.ts`: the two-step walk is what
 * makes a person-only task fire at all, and step 2's first branch is what keeps
 * a targeted task with a content condition from firing on everything its person
 * says. The model-facing word stays "rules" — see `format.ts`.
 *
 * Known limit of v1: the matcher reads the message's words. A task triggered by
 * something with no text to quote (a bare photo, a sticker) cannot match here.
 */

export const TASK_MATCH_SYSTEM_PROMPT = `You decide whether a chat message triggers one of the chat's standing rules.

A Telegram bot is in this chat, and the people here have given it standing rules — instructions about what it must do when certain things are said or posted. Your only job is to decide which of the listed rules, if any, this specific message triggers. You are not writing a reply, and you are not judging whether the message was addressed to the bot.

Take each rule in two steps, and stop at the first step it fails.

Step 1 — who it applies to. A rule written as "if message from <person>: …" applies to that person and to nobody else. The sender is named directly above the message: compare the two names. A different person means the rule does not trigger, whatever the message says. Never look for the person's name inside the message — who is speaking is not something the message says. A rule with no "if message from" part applies to everybody, and passes this step.

Step 2 — what it asks of the message. Read what is left of the rule after the "if message from <person>:" part, and decide which of these it is:
- It names something that has to be in the message — a link, a word, a phrase, a kind of request, a subject someone has to raise. Then this message must actually contain that thing. Not something similar, not something related, not a topic the rule is about. If it is not there, the rule does not trigger.
- It only says what the bot must do, and names nothing that has to be in the message. Then step 1 was the rule's whole condition, and the rule triggers on this message.

For example, where the sender is "Ann (@ann)" and the message is "morning all, coffee?":
- "if message from Ann (@ann): call her the boss" — nothing has to be in the message, so it triggers.
- "if message from Ann (@ann): download any video link she posts" — a video link has to be in the message, and there is none, so it does not trigger.
- "if message from Bob (@bob): call him the boss" — the wrong person sent it, so it does not trigger.

Judge strictly:
- If no rule clearly fits the message, the answer is an empty list. That is the normal answer for ordinary conversation, and it is always safe.
- Never invent a rule number that was not listed.

For every rule you say triggers, copy the exact part of the message that triggers it into "quote" — verbatim, character for character, as it appears in the message (for example the link, the word, or the phrase itself). When a rule asks for nothing in particular from the message — its whole condition is who sent it, and that person sent this one — there is no such part to point at: copy the message itself into "quote" instead. Otherwise, if you cannot point to the part of the message that triggers the rule, the rule does not trigger.

Reply with ONLY a JSON object of the shape {"matched": [{"rule": <number>, "quote": "<verbatim text from the message>"}]} — no code fences, no commentary. When nothing triggers, reply {"matched": []}.`;

/** The task fields the matcher needs. */
export interface MatchableTask {
  id: string;
  instruction: string;
  /**
   * Display labels of the people the task is limited to, empty for a task that
   * applies to everyone. Labels rather than ids: the sender is named the same
   * way over the message, so the model compares two names instead of matching
   * an id it was never shown.
   */
  targetLabels?: readonly string[];
}

export interface TaskMatchInput {
  /** The chat's offered tasks, in the order they are numbered. */
  tasks: readonly MatchableTask[];
  /** The message's user text (body, caption, or voice transcript). */
  text: string;
  /** Telegram chat type, for context only. */
  chatType: string;
  /** Who sent this message, labelled as the tasks label their people. */
  senderLabel?: string | null;
}

/** One offered task, prefixed with its audience when it has one. */
function taskLine(task: MatchableTask, index: number): string {
  const audience =
    task.targetLabels && task.targetLabels.length > 0
      ? `if message from ${task.targetLabels.join(" or ")}: `
      : "";
  return `${index + 1}. ${audience}${task.instruction}`;
}

/** The messages for one matcher call: the fixed tasks, then this message. */
export function buildTaskMatchMessages(input: TaskMatchInput): ChatMessage[] {
  const numbered = input.tasks.map(taskLine).join("\n");
  const sender = input.senderLabel?.trim();
  return [
    { role: "system", content: TASK_MATCH_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Chat type: ${input.chatType}\n\n` +
        `Standing rules:\n${numbered}\n\n` +
        `${sender ? `Message from ${sender}` : "Message"}:\n${input.text.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface TaskMatchVerdict {
  /** Ids of the tasks that survived the citation check, in offered order. */
  matchedIds: string[];
  /** Human-readable summary of the decision, recorded on the trace. */
  reason: string;
}

/** One accepted or rejected claim, for the trace. */
interface Claim {
  rule: number;
  quote: string;
}

function readClaims(value: unknown): Claim[] {
  if (!Array.isArray(value)) return [];
  const claims: Claim[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rule = Number(record.rule);
    if (!Number.isInteger(rule)) continue;
    claims.push({ rule, quote: typeof record.quote === "string" ? record.quote.trim() : "" });
  }
  return claims;
}

/**
 * Read the matcher's answer and derive the decision from it. Fails closed at
 * every step: an unreadable answer, an unknown task number, a missing quote, or
 * a quote that does not occur in the message all mean "no match" — the bot stays
 * out of a conversation it was not invited into.
 */
export function parseTaskMatchVerdict(
  content: string,
  input: { tasks: readonly MatchableTask[]; text: string },
): TaskMatchVerdict {
  const parsed = extractJsonObject(content);
  if (!parsed || !("matched" in parsed)) {
    return { matchedIds: [], reason: "unreadable matcher answer — treated as no match" };
  }
  const claims = readClaims(parsed.matched);
  if (claims.length === 0) return { matchedIds: [], reason: "no rule triggered" };

  const haystack = input.text.toLowerCase();
  const matchedIds: string[] = [];
  const rejected: string[] = [];
  for (const claim of claims) {
    const task = input.tasks[claim.rule - 1];
    if (!task) {
      rejected.push(`rule ${claim.rule} was never offered`);
      continue;
    }
    if (!claim.quote) {
      rejected.push(`rule ${claim.rule} claimed without quoting the message`);
      continue;
    }
    if (!haystack.includes(claim.quote.toLowerCase())) {
      rejected.push(`quote "${claim.quote}" for rule ${claim.rule} does not occur in the message`);
      continue;
    }
    if (!matchedIds.includes(task.id)) matchedIds.push(task.id);
  }

  if (matchedIds.length === 0) {
    return {
      matchedIds: [],
      reason: `no rule survived the citation check — ${rejected.join("; ")}`,
    };
  }
  const suffix = rejected.length > 0 ? ` (rejected: ${rejected.join("; ")})` : "";
  return {
    matchedIds,
    reason: `${matchedIds.length} rule(s) triggered${suffix}`,
  };
}
