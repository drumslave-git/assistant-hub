import { describe, expect, it } from "vitest";

import { buildRuleMatchMessages, parseRuleMatchVerdict } from "./matcher";

/**
 * The `always`-rule matcher: the only path by which the bot acts on a message
 * nobody sent it, so every test here is about *not* answering unless the model
 * earned it — an unknown rule number, a missing quote, or an invented quote all
 * fail closed, exactly like the addressing analyzer's citation check.
 */

const RULES = [
  { id: "r1", text: "When someone posts a video link, download it." },
  { id: "r2", text: "When someone says good morning, greet them." },
];

const MESSAGE = "look at this https://example.com/clip/42 lol";

function parse(content: string, text = MESSAGE) {
  return parseRuleMatchVerdict(content, { rules: RULES, text });
}

describe("buildRuleMatchMessages", () => {
  it("offers the rules numbered from 1, with the message and the chat type", () => {
    const [system, user] = buildRuleMatchMessages({
      rules: RULES,
      text: MESSAGE,
      chatType: "supergroup",
    });
    expect(system.role).toBe("system");
    expect(user.content).toContain("1. When someone posts a video link, download it.");
    expect(user.content).toContain("2. When someone says good morning, greet them.");
    expect(user.content).toContain(MESSAGE);
    expect(user.content).toContain("supergroup");
  });
});

describe("parseRuleMatchVerdict", () => {
  it("accepts a rule whose quote occurs in the message", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"https://example.com/clip/42"}]}');
    expect(verdict.matchedIds).toEqual(["r1"]);
  });

  it("reads an empty list as the ordinary no-match answer", () => {
    const verdict = parse('{"matched":[]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toBe("no rule triggered");
  });

  it("treats an unreadable answer as no match", () => {
    expect(parse("I think rule 1 applies!").matchedIds).toEqual([]);
    expect(parse("").matchedIds).toEqual([]);
    expect(parse('{"other":true}').matchedIds).toEqual([]);
  });

  it("rejects a rule number that was never offered", () => {
    const verdict = parse('{"matched":[{"rule":7,"quote":"lol"}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("never offered");
  });

  it("rejects a match claimed without a quote", () => {
    const verdict = parse('{"matched":[{"rule":1}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("without quoting");
  });

  it("rejects a quote the message does not contain", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"https://other.example/nope"}]}');
    expect(verdict.matchedIds).toEqual([]);
    expect(verdict.reason).toContain("does not occur");
  });

  it("matches the quote case-insensitively", () => {
    expect(parse('{"matched":[{"rule":1,"quote":"HTTPS://EXAMPLE.COM/CLIP/42"}]}').matchedIds).toEqual([
      "r1",
    ]);
  });

  it("keeps the surviving rules when only some claims check out", () => {
    const verdict = parse(
      '{"matched":[{"rule":1,"quote":"https://example.com/clip/42"},{"rule":2,"quote":"good morning"}]}',
    );
    expect(verdict.matchedIds).toEqual(["r1"]);
    expect(verdict.reason).toContain("rejected");
  });

  it("does not report the same rule twice", () => {
    const verdict = parse('{"matched":[{"rule":1,"quote":"lol"},{"rule":1,"quote":"look"}]}');
    expect(verdict.matchedIds).toEqual(["r1"]);
  });

  it("reads a fenced answer the model wrapped in prose", () => {
    const verdict = parse('Sure!\n```json\n{"matched":[{"rule":1,"quote":"lol"}]}\n```');
    expect(verdict.matchedIds).toEqual(["r1"]);
  });
});
