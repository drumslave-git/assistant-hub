import { describe, expect, it } from "vitest";

import {
  alwaysRules,
  buildChatRulesBlock,
  buildRuleTriggerDirective,
  replyRules,
  resolveRuleAuthority,
  triggerLabel,
} from "./format";
import type { ChatRule } from "./server/schema";

/**
 * Prompt composition for chat rules: what the model is actually told. These are
 * the only place a rule's wording is decided, so the assertions are about the
 * contract (numbering, scope marking, the action/honesty clauses), not phrasing
 * word for word.
 */

function rule(over: Partial<ChatRule> = {}): ChatRule {
  return {
    id: "rule-1",
    chatId: "-1001",
    text: "Answer briefly.",
    trigger: "on-reply",
    enabled: true,
    createdByUserId: null,
    source: "dashboard",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...over,
  };
}

describe("buildChatRulesBlock", () => {
  it("returns null when there is nothing to say", () => {
    expect(buildChatRulesBlock([])).toBeNull();
    expect(buildChatRulesBlock([{ text: "   ", trigger: "on-reply" }])).toBeNull();
  });

  it("numbers the rules and keeps their text verbatim", () => {
    const block = buildChatRulesBlock([
      { text: "Answer briefly.", trigger: "on-reply" },
      { text: "Download video links.", trigger: "always" },
    ]);
    expect(block).toContain("1. Answer briefly.");
    expect(block).toContain("2. Download video links.");
  });

  it("marks a global rule as applying everywhere", () => {
    const block = buildChatRulesBlock([{ text: "Never swear.", trigger: "on-reply", chatId: null }]);
    expect(block).toContain("Never swear. (applies in every chat)");
  });

  it("binds an action rule to a tool call and allows an honest failure", () => {
    const block = buildChatRulesBlock([{ text: "Download video links.", trigger: "always" }])!;
    // The three clauses that make a rule more than decoration.
    expect(block).toMatch(/binding instructions/i);
    expect(block).toMatch(/calling the tool/i);
    expect(block).toMatch(/refuses|not allowed/i);
  });
});

describe("buildRuleTriggerDirective", () => {
  it("says nobody addressed the bot and lists what matched", () => {
    const directive = buildRuleTriggerDirective([
      { text: "Download video links.", trigger: "always" },
    ]);
    expect(directive).toMatch(/nobody in this chat addressed you/i);
    expect(directive).toContain("1. Download video links.");
    // The narrowing clause: a rule-opened turn is not an invitation to chat.
    expect(directive).toMatch(/nothing else/i);
  });
});

describe("rule selection", () => {
  it("composes only enabled rules, and matches only enabled `always` ones", () => {
    const rules = [
      rule({ id: "a" }),
      rule({ id: "b", enabled: false }),
      rule({ id: "c", trigger: "always" }),
      rule({ id: "d", trigger: "always", enabled: false }),
    ];
    expect(replyRules(rules).map((r) => r.id)).toEqual(["a", "c"]);
    expect(alwaysRules(rules).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("triggerLabel", () => {
  it("labels both modes", () => {
    expect(triggerLabel("always")).toBe("Always");
    expect(triggerLabel("on-reply")).toBe("On reply");
  });
});

/**
 * Whose rights a rule-driven action carries. A rule is its author's standing
 * order, so the author's permissions apply and not the sender's ("rule creator
 * beats message source" — user decision, 2026-07-29). Only the owner is a
 * privileged identity here, so elevation is exactly: a rule the owner wrote, or
 * one written in the operator-only dashboard.
 */
describe("resolveRuleAuthority", () => {
  const OWNER = "1";

  it("elevates to the owner for a rule the owner set from chat", () => {
    const matched = [rule({ source: "chat", createdByUserId: OWNER })];
    expect(resolveRuleAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates to the owner for a rule the operator set in the dashboard", () => {
    const matched = [rule({ source: "dashboard", createdByUserId: null })];
    expect(resolveRuleAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates nothing for a rule an ordinary user set in their own DM", () => {
    const matched = [rule({ source: "chat", createdByUserId: "77" })];
    expect(resolveRuleAuthority(matched, OWNER)).toBeNull();
  });

  it("elevates when any one of the matched rules qualifies", () => {
    const matched = [
      rule({ id: "a", source: "chat", createdByUserId: "77" }),
      rule({ id: "b", source: "chat", createdByUserId: OWNER }),
    ];
    expect(resolveRuleAuthority(matched, OWNER)).toBe(OWNER);
  });

  it("elevates nothing when nothing matched", () => {
    expect(resolveRuleAuthority([], OWNER)).toBeNull();
  });

  it("elevates nothing when no owner is configured", () => {
    const matched = [rule({ source: "dashboard", createdByUserId: null })];
    expect(resolveRuleAuthority(matched, null)).toBeNull();
  });
});
