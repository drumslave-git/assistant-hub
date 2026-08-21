import { describe, expect, it } from "vitest";

import {
  buildPeriodRollupRequest,
  formatTranscript,
  isStructuralWord,
  parseHourInsight,
  parseRollupChoice,
} from "./prompt";

describe("parseHourInsight", () => {
  it("parses a well-formed object", () => {
    const out = parseHourInsight(
      '{"moodScore":72,"moodLabel":"warm","moodSummary":"friendly banter","topTopic":"weekend plans","word":"beach"}',
    );
    expect(out).toEqual({
      moodScore: 72,
      moodLabel: "warm",
      moodSummary: "friendly banter",
      topTopic: "weekend plans",
      word: "beach",
    });
  });

  it("tolerates code fences and derives missing fields", () => {
    const out = parseHourInsight('Here it is:\n```json\n{"moodScore":40,"topTopic":"bug reports"}\n```');
    expect(out?.moodScore).toBe(40);
    expect(out?.topTopic).toBe("bug reports");
    // Missing label is derived from the score; missing word falls back to the topic.
    expect(out?.moodLabel).toBe("tense");
    expect(out?.word).toBe("bug");
  });

  it("clamps an out-of-range score", () => {
    expect(parseHourInsight('{"moodScore":250,"topTopic":"x"}')?.moodScore).toBe(100);
  });

  it("replaces a word that describes the medium rather than the subject", () => {
    // The reported bug: a chat full of shared URLs reported its word as "links".
    // Corrected rather than rejected, so the hour still scores and is never re-billed.
    const out = parseHourInsight('{"moodScore":60,"topTopic":"kayaking trip","word":"links"}');
    expect(out?.word).toBe("kayaking");
    expect(out?.topTopic).toBe("kayaking trip");
  });

  it("does not fall back onto a structural word from the topic itself", () => {
    // Caught on real data after the first backfill: the topic "bot project" fell back
    // to "bot" — the guard handing back exactly the kind of word it had just
    // rejected. The fallback scans past structural words instead of taking the first.
    expect(parseHourInsight('{"moodScore":50,"topTopic":"bot project","word":"links"}')?.word)
      .toBe("project");
    expect(parseHourInsight('{"moodScore":50,"topTopic":"chat message topics"}')?.word)
      // Nothing substantive to pick: the topic's own first word is all there is.
      .toBe("chat");
  });

  it("fails closed when the topic or score is missing", () => {
    expect(parseHourInsight('{"moodScore":50}')).toBeNull();
    expect(parseHourInsight('{"topTopic":"x"}')).toBeNull();
    expect(parseHourInsight("not json at all")).toBeNull();
  });
});

describe("isStructuralWord", () => {
  it("catches medium words and umbrella words, case- and punctuation-insensitively", () => {
    expect(isStructuralWord("Links")).toBe(true);
    expect(isStructuralWord("messages.")).toBe(true);
    expect(isStructuralWord("miscellaneous")).toBe(true);
    expect(isStructuralWord("kayaking")).toBe(false);
  });
});

describe("parseRollupChoice", () => {
  it("maps the model's 1-based menu numbers onto 0-based indices", () => {
    expect(parseRollupChoice('{"topicIndex":2,"wordIndex":3}', 4)).toEqual({
      topicIndex: 1,
      wordIndex: 2,
    });
  });

  it("accepts numbers sent as strings", () => {
    expect(parseRollupChoice('{"topicIndex":"1","wordIndex":"2"}', 3)).toEqual({
      topicIndex: 0,
      wordIndex: 1,
    });
  });

  it("rejects an index outside the menu it was offered", () => {
    // The guarantee that makes "miscellaneous topics" unrepresentable: the model can
    // only ever point at a sub-period that really existed.
    expect(parseRollupChoice('{"topicIndex":9,"wordIndex":9}', 3)).toBeNull();
    expect(parseRollupChoice('{"topicIndex":0,"wordIndex":0}', 3)).toBeNull();
  });

  it("keeps one usable index when its partner is malformed", () => {
    expect(parseRollupChoice('{"topicIndex":2,"wordIndex":"nonsense"}', 4)).toEqual({
      topicIndex: 1,
      wordIndex: 1,
    });
  });

  it("returns null for an unusable response or an empty menu", () => {
    expect(parseRollupChoice("{}", 3)).toBeNull();
    expect(parseRollupChoice("not json", 3)).toBeNull();
    expect(parseRollupChoice('{"topicIndex":1}', 0)).toBeNull();
  });
});

describe("formatTranscript", () => {
  it("labels roles and drops empty messages", () => {
    const text = formatTranscript([
      { role: "user", content: "hi there" },
      { role: "assistant", content: "hello!" },
      { role: "user", content: "   " },
    ]);
    expect(text).toBe("User: hi there\nBot: hello!");
  });
});

describe("buildPeriodRollupRequest", () => {
  it("numbers each sub-period so the model can only choose one of them", () => {
    const req = buildPeriodRollupRequest({
      label: "month 2026-07",
      children: [
        { bucket: "2026-07-01", moodLabel: "positive", topTopic: "launch", word: "ship", messageCount: 12 },
        { bucket: "2026-07-02", moodLabel: "tense", topTopic: "outage", word: "rollback", messageCount: 40 },
      ],
    });
    expect(req).toContain("month 2026-07");
    expect(req).toContain("1. 2026-07-01 — mood positive — topic: launch — word: ship (12 msgs)");
    expect(req).toContain("2. 2026-07-02 — mood tense — topic: outage — word: rollback (40 msgs)");
  });
});
