import { describe, expect, it } from "vitest";

import { buildResult, mergeMatches, SELF_AUTHORED_ONLY_NOTE } from "./mcp-tools";
import type { ChatMessageRecord } from "./repository";
import type { MessageSearchMatch } from "./search-repository";

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
          author: "you (the bot)",
        },
      ],
    });
  });

  it("names the person when the caller resolved labels", () => {
    const labels = new Map([["42", "Bea"]]);
    const text = textOf(buildResult([record({ content: "look at this" })], { labels }));
    // "find the photo Bea sent" is unanswerable if every hit reads `a participant`.
    expect(text).toContain("Bea: look at this");
  });

  it("still anonymizes a participant with no resolved label", () => {
    const text = textOf(buildResult([record()], { labels: new Map() }));
    expect(text).toContain("a participant: hello");
  });

  it("appends the media annotation, so an uncaptioned photo reads as what it shows", () => {
    const mediaSuffixes = new Map([[11, " [photo: a weathered blue front door]"]]);
    const result = buildResult([record({ content: "" })], { mediaSuffixes });
    expect(textOf(result)).toContain("[photo: a weathered blue front door]");
    // The structured payload carries the same text — a machine consumer reading
    // only `content` would otherwise see an empty string for the whole hit.
    expect(result.structuredContent.messages[0].content).toBe(
      " [photo: a weathered blue front door]",
    );
  });

  it("still calls out a self-authored-only result when the hits carry media", () => {
    const text = textOf(
      buildResult([record({ role: "assistant", userId: null, content: "" })], {
        mediaSuffixes: new Map([[11, " [photo: a chart]"]]),
      }),
    );
    expect(text).toContain(SELF_AUTHORED_ONLY_NOTE);
  });
});

describe("mergeMatches", () => {
  function match(over: Partial<MessageSearchMatch> & { id: number; score: number }): MessageSearchMatch {
    return {
      ...record({ id: over.id, telegramMessageId: over.id + 10 }),
      indexedContent: null,
      mediaKind: null,
      ...over,
    };
  }

  it("keeps a message's best score across phrasings rather than its last", () => {
    const merged = mergeMatches(
      [
        [match({ id: 1, score: 0.1 })],
        [match({ id: 1, score: 0.9 })],
      ],
      10,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].score).toBe(0.9);
  });

  it("selects by relevance but returns in message order", () => {
    // 3 is the weakest hit and must be dropped by the cap; the two that survive
    // come back oldest-first, so the transcript reads forwards.
    const merged = mergeMatches(
      [[match({ id: 3, score: 0.1 }), match({ id: 2, score: 0.5 }), match({ id: 1, score: 0.9 })]],
      2,
    );
    expect(merged.map((m) => m.id)).toEqual([1, 2]);
  });
});
