import { describe, expect, it } from "vitest";

import {
  batchMessages,
  buildSummaryPrompt,
  currentSummaryDate,
  isSummarizableDay,
  parseSummaryTopics,
  SUMMARY_BATCH_CHARS,
  summaryDayBounds,
  toSummaryLine,
  type SummarizableMessage,
} from "./summary";

function message(overrides: Partial<SummarizableMessage> = {}): SummarizableMessage {
  return {
    telegramMessageId: 1,
    role: "user",
    content: "hello",
    label: "Alice",
    userId: "1001",
    sentAt: "2026-07-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("toSummaryLine / buildSummaryPrompt", () => {
  it("anchors every line by message id so topics can point back at originals", () => {
    expect(toSummaryLine(message({ telegramMessageId: 42, content: "deploy is broken" }))).toBe(
      "[#42] [2026-07-13T10:00:00.000Z] Alice: deploy is broken",
    );
  });

  it("names the day being summarized and lists the transcript", () => {
    const prompt = buildSummaryPrompt("2026-07-13", [
      message({ telegramMessageId: 1, content: "hi" }),
      message({ telegramMessageId: 2, content: "hey", label: "Bot", role: "assistant" }),
    ]);
    expect(prompt).toContain("on 2026-07-13");
    expect(prompt).toContain("[#1]");
    expect(prompt).toContain("[#2]");
  });
});

describe("batchMessages", () => {
  it("keeps a small day in a single pass", () => {
    const batches = batchMessages([message(), message({ telegramMessageId: 2 })]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("splits a day that exceeds the budget, losing no message", () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      message({ telegramMessageId: i + 1, content: "x".repeat(100) }),
    );
    const batches = batchMessages(messages, 300);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toHaveLength(10);
    expect(batches.flat().map((m) => m.telegramMessageId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  it("gives an oversized single message its own batch rather than dropping it", () => {
    const batches = batchMessages(
      [
        message({ telegramMessageId: 1, content: "small" }),
        message({ telegramMessageId: 2, content: "x".repeat(SUMMARY_BATCH_CHARS * 2) }),
      ],
      SUMMARY_BATCH_CHARS,
    );
    expect(batches).toHaveLength(2);
    expect(batches[1][0].telegramMessageId).toBe(2);
  });

  it("returns nothing for an empty day", () => {
    expect(batchMessages([])).toEqual([]);
  });
});

describe("parseSummaryTopics", () => {
  it("parses the requested shape", () => {
    const raw = '{"topics":[{"content":"Discussed the outage","message_ids":[1,2,3]}]}';
    expect(parseSummaryTopics(raw)).toEqual([
      { content: "Discussed the outage", messageIds: [1, 2, 3] },
    ]);
  });

  it("tolerates code fences and prose around the JSON", () => {
    const raw = 'Sure!\n```json\n{"topics":[{"content":"Lunch plans","message_ids":[7]}]}\n```';
    expect(parseSummaryTopics(raw)).toEqual([{ content: "Lunch plans", messageIds: [7] }]);
  });

  it("returns nothing for a day the model found unsubstantive", () => {
    expect(parseSummaryTopics('{"topics":[]}')).toEqual([]);
  });

  it("drops topics with no content and filters junk ids", () => {
    const raw = JSON.stringify({
      topics: [
        { content: "   ", message_ids: [1] },
        { content: "Real topic", message_ids: [1, "two", -3, 4.5, 5, 5] },
      ],
    });
    expect(parseSummaryTopics(raw)).toEqual([{ content: "Real topic", messageIds: [1, 5] }]);
  });

  it("never throws on garbage output", () => {
    expect(parseSummaryTopics("the model rambled")).toEqual([]);
    expect(parseSummaryTopics("")).toEqual([]);
    expect(parseSummaryTopics('{"topics": "not an array"}')).toEqual([]);
  });
});

describe("summaryDayBounds", () => {
  it("bounds the operator's wall-clock day, not UTC's", () => {
    // Kyiv is UTC+3 in July, so the local day starts at 21:00 UTC the day before.
    const { from, to } = summaryDayBounds("2026-07-14", "Europe/Kyiv");
    expect(from.toISOString()).toBe("2026-07-13T21:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-14T21:00:00.000Z");
  });

  it("is exactly a day wide in UTC", () => {
    const { from, to } = summaryDayBounds("2026-07-14", "UTC");
    expect(from.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-15T00:00:00.000Z");
  });

  it("spans a month boundary", () => {
    const { from, to } = summaryDayBounds("2026-07-31", "UTC");
    expect(from.toISOString()).toBe("2026-07-31T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

describe("currentSummaryDate / isSummarizableDay", () => {
  it("reads today in the operator's zone", () => {
    // 22:30 UTC on the 13th is already the 14th in Kyiv (UTC+3).
    const now = new Date("2026-07-13T22:30:00Z");
    expect(currentSummaryDate(now, "Europe/Kyiv")).toBe("2026-07-14");
    expect(currentSummaryDate(now, "UTC")).toBe("2026-07-13");
  });

  it("never summarizes today — it is unfinished and already injected in full", () => {
    const now = new Date("2026-07-14T12:00:00Z");
    expect(isSummarizableDay("2026-07-13", now, "UTC")).toBe(true);
    expect(isSummarizableDay("2026-07-14", now, "UTC")).toBe(false);
  });
});
