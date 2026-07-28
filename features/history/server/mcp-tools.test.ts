import { describe, expect, it } from "vitest";

import { buildResult, SELF_AUTHORED_ONLY_NOTE } from "./mcp-tools";
import type { ChatMessageRecord } from "./repository";

/**
 * The history tools' result format, pinned on the one property grounding depends
 * on: a caller must be able to tell who wrote each hit, and must be told when a
 * lookup found nothing but the bot's own words (production, 2026-07-28 — a search
 * that returns the bot's own past assertions otherwise reads as confirmation).
 */

function record(over: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: 1,
    chatId: "-100",
    telegramMessageId: 11,
    role: "user",
    userId: "42",
    content: "hello",
    replyToMessageId: null,
    sentAt: "2026-07-28T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-07-28T10:00:00.000Z",
    ...over,
  };
}

/** The result's text block — what the model actually reads. */
function textOf(result: ReturnType<typeof buildResult>): string {
  return result.content[0].text;
}

describe("buildResult", () => {
  it("names the author of each line in words, not as a wire role", () => {
    const text = textOf(
      buildResult([
        record({ id: 1, telegramMessageId: 11, role: "user", content: "who is X?" }),
        record({ id: 2, telegramMessageId: 12, role: "assistant", userId: null, content: "X is Y" }),
      ]),
    );
    expect(text).toContain("[#11] [2026-07-28T10:00:00.000Z] a participant: who is X?");
    expect(text).toContain("[#12] [2026-07-28T10:00:00.000Z] you (the bot): X is Y");
    expect(text).not.toMatch(/\bassistant\b/);
  });

  it("keeps the reply anchor between the author and the text", () => {
    const text = textOf(buildResult([record({ replyToMessageId: 7 })]));
    expect(text).toContain("a participant [reply to #7]: hello");
  });

  it("flags a result that is entirely the bot's own messages", () => {
    const text = textOf(
      buildResult([
        record({ id: 1, telegramMessageId: 11, role: "assistant", userId: null }),
        record({ id: 2, telegramMessageId: 12, role: "assistant", userId: null }),
      ]),
    );
    expect(text).toContain(SELF_AUTHORED_ONLY_NOTE);
    expect(SELF_AUTHORED_ONLY_NOTE).toContain("Treat this as not found.");
  });

  it("does not flag a result containing even one participant message", () => {
    const text = textOf(
      buildResult([
        record({ id: 1, telegramMessageId: 11, role: "assistant", userId: null }),
        record({ id: 2, telegramMessageId: 12, role: "user" }),
      ]),
    );
    expect(text).not.toContain(SELF_AUTHORED_ONLY_NOTE);
  });

  it("does not flag an empty result — nothing was found to be self-authored", () => {
    const text = textOf(buildResult([]));
    expect(text).toBe("(no matching messages)");
    expect(text).not.toContain(SELF_AUTHORED_ONLY_NOTE);
  });

  it("keeps the raw role on the structured payload for machine consumers", () => {
    const result = buildResult([record({ role: "assistant", userId: null, replyToMessageId: 7 })]);
    expect(result.structuredContent).toEqual({
      ok: true,
      count: 1,
      messages: [
        {
          id: 11,
          replyTo: 7,
          role: "assistant",
          content: "hello",
          at: "2026-07-28T10:00:00.000Z",
        },
      ],
    });
  });
});
