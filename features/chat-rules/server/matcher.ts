import { extractJsonObject } from "@/lib/json";
import type { ChatMessage } from "@/server/llm/client";

/**
 * The LLM half of a standing rule: which of this chat's rules, if any, does the
 * current message trigger?
 *
 * Prompt building and parsing are pure, so the whole decision is unit-testable
 * without a provider. The caller (the Telegram runtime) owns the completion and
 * the trace; this module owns what is asked and how the answer is read.
 *
 * Its answer decides two separate things, which is why it runs on addressed and
 * unaddressed messages alike:
 *  - **whether to answer at all** — a matched `always` rule opens a turn nobody
 *    addressed the bot in (the addressing check having already said "not
 *    addressed");
 *  - **whose rights the turn carries** — a matched rule lends its author's
 *    permissions to the action it calls for (see `resolveRuleAuthority`), so an
 *    owner's rule works on everyone's messages and not only the owner's.
 *
 * Both are things the bot has to earn, so the answer is earned twice over, on
 * the addressing analyzer's pattern: the model names the rule by its offered
 * number *and* quotes the part of the message that triggers it, and a match only
 * counts when that quote occurs verbatim in the message. Code checks only what
 * is mechanical (the number is one that was offered, the quote is real);
 * whether the rule genuinely applies stays the model's judgment.
 *
 * Known limit of v1: the matcher reads the message's words. A rule triggered by
 * something with no text to quote (a bare photo, a sticker) cannot match here.
 */

export const RULE_MATCH_SYSTEM_PROMPT = `You decide whether a chat message triggers one of the chat's standing rules.

A Telegram bot is in this chat, and the people here have given it standing rules — instructions about what it must do when certain things are said or posted. Your only job is to decide which of the listed rules, if any, this specific message triggers. You are not writing a reply, and you are not judging whether the message was addressed to the bot.

Judge strictly:
- A rule triggers only when this message contains exactly what the rule describes. Not something similar, not something related, not a topic the rule is about.
- If no rule clearly fits the message, the answer is an empty list. That is the normal answer for ordinary conversation, and it is always safe.
- Never invent a rule number that was not listed.

For every rule you say triggers, copy the exact part of the message that triggers it into "quote" — verbatim, character for character, as it appears in the message (for example the link, the word, or the phrase itself). If you cannot point to such a part of the message, the rule does not trigger.

Reply with ONLY a JSON object of the shape {"matched": [{"rule": <number>, "quote": "<verbatim text from the message>"}]} — no code fences, no commentary. When nothing triggers, reply {"matched": []}.`;

/** The rule fields the matcher needs. */
export interface MatchableRule {
  id: string;
  text: string;
}

export interface RuleMatchInput {
  /** The chat's enabled `always` rules, in the order they are offered. */
  rules: readonly MatchableRule[];
  /** The message's user text (body, caption, or voice transcript). */
  text: string;
  /** Telegram chat type, for context only. */
  chatType: string;
}

/** The messages for one matcher call: the fixed rules, then this message. */
export function buildRuleMatchMessages(input: RuleMatchInput): ChatMessage[] {
  const numbered = input.rules.map((rule, index) => `${index + 1}. ${rule.text}`).join("\n");
  return [
    { role: "system", content: RULE_MATCH_SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Chat type: ${input.chatType}\n\n` +
        `Standing rules:\n${numbered}\n\n` +
        `Message:\n${input.text.trim()}\n\n` +
        `Reply with only the JSON object.`,
    },
  ];
}

export interface RuleMatchVerdict {
  /** Ids of the rules that survived the citation check, in offered order. */
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
 * every step: an unreadable answer, an unknown rule number, a missing quote, or
 * a quote that does not occur in the message all mean "no match" — the bot stays
 * out of a conversation it was not invited into.
 */
export function parseRuleMatchVerdict(
  content: string,
  input: { rules: readonly MatchableRule[]; text: string },
): RuleMatchVerdict {
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
    const rule = input.rules[claim.rule - 1];
    if (!rule) {
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
    if (!matchedIds.includes(rule.id)) matchedIds.push(rule.id);
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
