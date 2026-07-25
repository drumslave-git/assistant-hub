import { describe, expect, it } from "vitest";

import { BOT } from "@/test/__mocks__/telegram";
import { buildAnalyzerMessages, parseAnalyzerVerdict } from "./address-analyzer";

describe("buildAnalyzerMessages", () => {
  const messages = buildAnalyzerMessages({
    bot: BOT,
    chatType: "supergroup",
    text: "  Ари, привет  ",
  });

  it("states the rules as a system message and the message to judge as the user turn", () => {
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("other_alphabet");
    expect(messages[0].content).toContain("matched_text");
  });

  it("gives the model the name it is looking for, the chat type, and the text", () => {
    expect(messages[1].content).toContain(`Bot display name: ${BOT.displayName}`);
    expect(messages[1].content).toContain(`Bot username: @${BOT.username}`);
    expect(messages[1].content).toContain("Chat type: supergroup");
    expect(messages[1].content).toContain("Ари, привет");
  });
});

describe("parseAnalyzerVerdict", () => {
  // BOT.displayName is "Aria"; "Аріє" is its Cyrillic vocative.
  const spoken = { text: "Аріє, шо думаєш?" };
  const chatter = { text: "Тупо без причини" };

  it("treats every present form of the name as addressed when the citation checks out", () => {
    for (const match of ["exact", "other_alphabet", "inflected"]) {
      const verdict = parseAnalyzerVerdict(
        `{"name_match": "${match}", "matched_text": "Аріє"}`,
        spoken,
      );
      expect(verdict).toEqual({
        addressed: true,
        nameMatch: match,
        matchedText: "Аріє",
        reason: `display name appears as ${match} ("Аріє")`,
      });
    }
  });

  it("matches the citation against the message case-insensitively", () => {
    const verdict = parseAnalyzerVerdict(
      '{"name_match": "inflected", "matched_text": "аріє"}',
      spoken,
    );
    expect(verdict.addressed).toBe(true);
  });

  it("treats an absent name as not addressed", () => {
    expect(parseAnalyzerVerdict('{"name_match": "absent"}', chatter)).toEqual({
      addressed: false,
      nameMatch: "absent",
      matchedText: null,
      reason: "display name absent",
    });
  });

  // The failure mode this layer exists for: a weak model stamping a match on a
  // message that never names the bot. An uncorroborated claim reads as absent.
  it("rejects a match claimed without a citation", () => {
    const verdict = parseAnalyzerVerdict('{"name_match": "other_alphabet"}', chatter);
    expect(verdict.addressed).toBe(false);
    expect(verdict.nameMatch).toBe("other_alphabet");
    expect(verdict.reason).toContain("without citing");
  });

  it("rejects a citation that is not in the message", () => {
    const verdict = parseAnalyzerVerdict(
      '{"name_match": "other_alphabet", "matched_text": "Ария"}',
      chatter,
    );
    expect(verdict.addressed).toBe(false);
    expect(verdict.matchedText).toBe("Ария");
    expect(verdict.reason).toContain("does not occur in the message");
  });

  it("rejects a citation that is only whitespace", () => {
    const verdict = parseAnalyzerVerdict(
      '{"name_match": "other_alphabet", "matched_text": "  "}',
      chatter,
    );
    expect(verdict.addressed).toBe(false);
    expect(verdict.matchedText).toBe(null);
  });

  it("reads an answer the model wrapped in fences or prose", () => {
    const raw = 'Sure!\n```json\n{"name_match": "inflected", "matched_text": "Аріє"}\n```';
    expect(parseAnalyzerVerdict(raw, spoken).addressed).toBe(true);
  });

  it("accepts a classification the model shouted or padded", () => {
    const verdict = parseAnalyzerVerdict(
      '{"name_match": " Exact ", "matched_text": "Аріє"}',
      spoken,
    );
    expect(verdict.nameMatch).toBe("exact");
  });

  // An answer we cannot read must not become a reply: the bot stays out of a
  // conversation it was never shown to be part of.
  it("stays silent on an answer it cannot read", () => {
    for (const raw of ["", "no idea", "{}", '{"name_match": "maybe"}', '{"name_match": 3}']) {
      expect(parseAnalyzerVerdict(raw, spoken)).toEqual({
        addressed: false,
        nameMatch: null,
        matchedText: null,
        reason: "unreadable analyzer answer",
      });
    }
  });
});
