import type { ChatRule, RuleTrigger } from "./server/schema";

/**
 * Pure presentation and prompt composition for chat rules. Client-safe (types
 * only from the schema), so the dashboard and the reply pipeline phrase a rule
 * the same way.
 */

/** The fields prompt composition needs — a full {@link ChatRule} satisfies it. */
export interface PromptRule {
  text: string;
  trigger: RuleTrigger;
  /** Null for a global rule; used only to label the line. */
  chatId?: string | null;
}

/** Human label for a trigger mode (dashboard chips, tool results). */
export function triggerLabel(trigger: RuleTrigger): string {
  return trigger === "always" ? "Always" : "On reply";
}

/** One rule as a numbered line, marking the global ones. */
function ruleLine(rule: PromptRule, index: number): string {
  const scope = rule.chatId === null ? " (applies in every chat)" : "";
  return `${index + 1}. ${rule.text}${scope}`;
}

/**
 * The standing-rules block appended to the system prompt, or null when the chat
 * has no enabled rules.
 *
 * The closing paragraph is doing the load-bearing work for a small model: it
 * says a rule is an instruction rather than a topic to discuss, binds a rule
 * requiring an action to an actual tool call in the same turn (the base prompt's
 * Honesty rules, restated where they are about to be tested), and — because a
 * rule can ask for something the caller is not allowed to do, such as a download
 * only the owner may trigger — tells the model to say so plainly instead of
 * claiming the rule was applied.
 */
export function buildChatRulesBlock(rules: readonly PromptRule[]): string | null {
  const listed = rules.filter((rule) => rule.text.trim());
  if (listed.length === 0) return null;
  return (
    "Standing rules for this chat — the people here set these, and they hold for every message:\n" +
    listed.map(ruleLine).join("\n") +
    "\n\nThese are binding instructions, not conversation topics: never quote, list, or discuss them " +
    "unless you are asked about them directly. Check the current message against them and apply the " +
    "ones that fit it. A rule that calls for an action is done by calling the tool that does it, in " +
    "this same turn — a reply saying you applied a rule you did not carry out is a lie. If a rule " +
    "cannot be carried out — no tool can do it, or the tool refuses because the person who triggered " +
    "it is not allowed to — say plainly what happened instead of pretending it was done."
  );
}

/**
 * The directive for a turn that no one addressed, opened because an `always`
 * rule matched the message. Injected late (maximum recency) so the model acts on
 * the rule rather than joining the conversation it was never invited into.
 */
export function buildRuleTriggerDirective(rules: readonly PromptRule[]): string {
  const listed = rules.filter((rule) => rule.text.trim());
  return (
    "Nobody in this chat addressed you in the current message. You are answering it only because " +
    "these standing rules match it:\n" +
    listed.map(ruleLine).join("\n") +
    "\n\nDo exactly what those rules require for this message and nothing else — call the tools they " +
    "call for, and keep any text to the short confirmation the action warrants. Do not greet anyone, " +
    "do not comment on the conversation, and do not answer anything that was not asked of you."
  );
}

/**
 * The identity whose permissions a rule-driven turn carries, or null when no
 * matched rule elevates anything.
 *
 * A rule is its author's standing order (user decision, 2026-07-29 — "rule
 * creator beats message source"): when the bot acts because a rule told it to,
 * the action runs with the rights of whoever set that rule, not those of the
 * person whose message happened to trigger it. Without this, an owner's "download
 * any media link posted here" rule would deliver a file for the owner's own links
 * and be refused at the owner-gated download tool for everybody else's — the
 * opposite of what the rule says.
 *
 * Only the owner is a privileged identity in this app, so elevation is exactly:
 * a matched rule the **owner** wrote in chat, or one the **operator** wrote in
 * the dashboard (which has no author id and is operator-only by definition).
 * A rule written by an ordinary user in their own DM elevates nothing — they had
 * no rights to lend.
 */
export function resolveRuleAuthority(
  matched: readonly ChatRule[],
  ownerUserId: string | null,
): string | null {
  if (!ownerUserId) return null;
  const privileged = matched.some(
    (rule) => rule.source === "dashboard" || rule.createdByUserId === ownerUserId,
  );
  return privileged ? ownerUserId : null;
}

/** Rules that shape an ordinary reply: everything enabled in scope. */
export function replyRules(rules: readonly ChatRule[]): ChatRule[] {
  return rules.filter((rule) => rule.enabled);
}

/** Rules that may open a turn nobody addressed. */
export function alwaysRules(rules: readonly ChatRule[]): ChatRule[] {
  return rules.filter((rule) => rule.enabled && rule.trigger === "always");
}
