import { describe, expect, it } from "vitest";

import {
  BASE_SYSTEM_PROMPT,
  buildAddressingHint,
  buildSystemPrompt,
  buildTimeContext,
  hasPersonality,
} from "./prompt";

describe("buildSystemPrompt", () => {
  it("returns the base prompt alone when no personality is given", () => {
    expect(buildSystemPrompt()).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ personalityPrompt: null })).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ personalityPrompt: "" })).toBe(BASE_SYSTEM_PROMPT);
    // Whitespace-only is treated as unset.
    expect(buildSystemPrompt({ personalityPrompt: "   \n  " })).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends a trimmed personality as additional instructions", () => {
    const out = buildSystemPrompt({ personalityPrompt: "  Be terse.  " });
    expect(out).toBe(`${BASE_SYSTEM_PROMPT}\n\n---\nAdditional instructions:\nBe terse.`);
  });

  it("preserves internal formatting of the personality prompt", () => {
    const persona = "Line one.\nLine two.";
    expect(buildSystemPrompt({ personalityPrompt: persona })).toContain(persona);
  });

  it("appends a trimmed self-correction block below the persona", () => {
    const out = buildSystemPrompt({
      personalityPrompt: "Be terse.",
      selfCorrection: "  Stop rambling.  ",
    });
    expect(out).toBe(
      `${BASE_SYSTEM_PROMPT}\n\n---\nAdditional instructions:\nBe terse.` +
        `\n\n---\nSelf-correction guidelines (learned from user feedback on your replies):\nStop rambling.`,
    );
  });

  it("appends the self-correction even without a personality", () => {
    const out = buildSystemPrompt({ selfCorrection: "Answer shorter." });
    expect(out).toBe(
      `${BASE_SYSTEM_PROMPT}\n\n---\nSelf-correction guidelines (learned from user feedback on your replies):\nAnswer shorter.`,
    );
  });

  it("treats a blank self-correction as unset", () => {
    expect(buildSystemPrompt({ selfCorrection: "   " })).toBe(BASE_SYSTEM_PROMPT);
    expect(buildSystemPrompt({ selfCorrection: null })).toBe(BASE_SYSTEM_PROMPT);
  });
});

describe("BASE_SYSTEM_PROMPT honesty rules", () => {
  it("binds action claims to tool calls made this turn", () => {
    expect(BASE_SYSTEM_PROMPT).toContain(
      "The only way you actually do anything beyond writing text is by calling one of the provided tools in this same turn.",
    );
    expect(BASE_SYSTEM_PROMPT).toContain("without the corresponding tool call, nothing happened");
  });

  it("denies persona/role-play exemption from the tool-call rule", () => {
    expect(BASE_SYSTEM_PROMPT).toContain("Staying in character never exempts you from this.");
    expect(BASE_SYSTEM_PROMPT).toContain("make the tool call first");
    expect(BASE_SYSTEM_PROMPT).toContain("say you cannot instead of playing along");
  });

  it("stays tool-agnostic: names the mechanism but never a specific tool", () => {
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/tasks_create|browse_web|history_|memory_|image_generate/);
  });
});

describe("buildTimeContext", () => {
  // A fixed instant: 2026-07-14T13:34:00Z.
  const now = new Date("2026-07-14T13:34:00Z");

  it("renders the local wall clock + weekday in the given timezone and the UTC instant", () => {
    const out = buildTimeContext(now, "Europe/Kyiv");
    // Kyiv is UTC+3 in July → 16:34, a Tuesday.
    expect(out).toContain("2026-07-14 16:34 (Tuesday)");
    expect(out).toContain("timezone Europe/Kyiv");
    expect(out).toContain("UTC 2026-07-14T13:34:00.000Z");
  });

  it("renders UTC when the operator timezone is UTC", () => {
    expect(buildTimeContext(now, "UTC")).toContain("2026-07-14 13:34 (Tuesday)");
  });

  it("names relative/named times as the thing to resolve, without naming any tool", () => {
    const out = buildTimeContext(now, "UTC");
    expect(out).toContain("in 5 minutes");
    expect(out).toContain("tomorrow");
    expect(out).not.toMatch(/tasks_create|browse_web|history_/);
  });

  it("falls back to UTC for an unusable timezone instead of throwing", () => {
    const out = buildTimeContext(now, "Not/AZone");
    expect(out).toContain("2026-07-14 13:34 (Tuesday)");
    expect(out).toContain("timezone UTC");
  });
});

describe("buildAddressingHint", () => {
  it("names the sender and how they addressed the bot", () => {
    const hint = buildAddressingHint({ senderLabel: "Bob (@bob)", source: "mention" });
    expect(hint).toContain("from Bob (@bob), who mentioned you");
    expect(hint).toContain("group chat");
  });

  it("phrases each group address source", () => {
    expect(buildAddressingHint({ senderLabel: "A", source: "reply" })).toContain(
      "replied to one of your messages",
    );
    expect(buildAddressingHint({ senderLabel: "A", source: "command" })).toContain(
      "sent you a command",
    );
  });

  it("falls back to a generic sender when the label is unknown", () => {
    expect(buildAddressingHint({ senderLabel: null, source: "mention" })).toContain(
      "from a group participant",
    );
  });

  it("returns null for private chats and unknown sources", () => {
    expect(buildAddressingHint({ senderLabel: "A", source: "private" })).toBeNull();
    expect(buildAddressingHint({ senderLabel: "A", source: "" })).toBeNull();
  });
});

describe("hasPersonality", () => {
  it("is true only for non-blank prompts", () => {
    expect(hasPersonality("x")).toBe(true);
    expect(hasPersonality(null)).toBe(false);
    expect(hasPersonality(undefined)).toBe(false);
    expect(hasPersonality("   ")).toBe(false);
  });
});
