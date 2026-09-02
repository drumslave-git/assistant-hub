import { describe, expect, it } from "vitest";

import { buildResult, mergeMatches, SELF_AUTHORED_ONLY_NOTE, unquote } from "./mcp-tools";
import type { ChatMessageRecord } from "./repository";
import type { SourceMessageMatch } from "@/server/source/content";

/**
 * The history tools' result format, pinned on the one property grounding depends
 * on: a caller must be able to tell who wrote each hit, and must be told when a
 * lookup found nothing but the bot's own words (production, 2026-07-28 — a search
 * that returns the bot's own past assertions otherwise reads as confirmation).
 */

function record(over: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  return {
    id: 1,
    chatRef: "tg:chat:-100",
    sourceMessageId: "11",
    role: "user",
    userId: "42",
    content: "hello",
    replyToSourceMessageId: null,
    sentAt: "2026-07-28T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    botReaction: null,
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
        record({ id: 1, sourceMessageId: "11", role: "user", content: "who is X?" }),
        record({ id: 2, sourceMessageId: "12", role: "assistant", userId: null, content: "X is Y" }),
      ]),
    );
    expect(text).toContain("[#11] [2026-07-28T10:00:00.000Z] a participant: who is X?");
    expect(text).toContain("[#12] [2026-07-28T10:00:00.000Z] you (the bot): X is Y");
    expect(text).not.toMatch(/\bassistant\b/);
  });

  it("keeps the reply anchor between the author and the text", () => {
    const text = textOf(buildResult([record({ replyToSourceMessageId: "7" })]));
    expect(text).toContain("a participant [reply to #7]: hello");
  });

  it("flags a result that is entirely the bot's own messages", () => {
    const text = textOf(
      buildResult([
        record({ id: 1, sourceMessageId: "11", role: "assistant", userId: null }),
        record({ id: 2, sourceMessageId: "12", role: "assistant", userId: null }),
      ]),
    );
    expect(text).toContain(SELF_AUTHORED_ONLY_NOTE);
    expect(SELF_AUTHORED_ONLY_NOTE).toContain("Treat this as not found.");
  });

  it("does not flag a result containing even one participant message", () => {
    const text = textOf(
      buildResult([
        record({ id: 1, sourceMessageId: "11", role: "assistant", userId: null }),
        record({ id: 2, sourceMessageId: "12", role: "user" }),
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
    const result = buildResult([record({ role: "assistant", userId: null, replyToSourceMessageId: "7" })]);
    expect(result.structuredContent).toEqual({
      ok: true,
      count: 1,
      messages: [
        {
          id: "11",
          replyTo: "7",
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
    const mediaSuffixes = new Map([["11", " [photo: a weathered blue front door]"]]);
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
        mediaSuffixes: new Map([["11", " [photo: a chart]"]]),
      }),
    );
    expect(text).toContain(SELF_AUTHORED_ONLY_NOTE);
  });
});

describe("search result size", () => {
  /** A vision description is 600–1500 chars; fifty of them buried a reply. */
  const longDescription = ` [photo: ${"a weathered blue front door ".repeat(40)}]`;

  it("cuts each hit to a snippet and marks the cut", () => {
    const text = textOf(
      buildResult([record({ content: "" })], {
        mediaSuffixes: new Map([["11", longDescription]]),
        maxContentChars: 220,
      }),
    );
    const line = text.split("\n")[0];
    expect(line.length).toBeLessThan(320);
    // Cut, not complete — the model must not read a snippet as the whole message.
    expect(line.endsWith("…")).toBe(true);
    // The anchor survives: it is the only part of the line that is acted on.
    expect(line).toContain("[#11]");
  });

  it("leaves a short hit untouched", () => {
    const text = textOf(
      buildResult([record({ content: "short" })], { maxContentChars: 220 }),
    );
    expect(text).toContain(": short");
    expect(text).not.toContain("…");
  });

  it("keeps every hit in full on the structured payload, which is trace-only", () => {
    const result = buildResult([record({ content: "" })], {
      mediaSuffixes: new Map([["11", longDescription]]),
      maxContentChars: 220,
    });
    // The loop feeds the model `result.text`; Debug records this verbatim, so
    // truncating it would lose the raw body an operator needs.
    expect(result.structuredContent.messages[0].content).toBe(longDescription);
  });

  it("appends the usage note to a non-empty result, and never to an empty one", () => {
    const note = "USAGE NOTE";
    expect(textOf(buildResult([record()], { usageNote: note }))).toContain(note);
    expect(textOf(buildResult([], { usageNote: note }))).toBe("(no matching messages)");
  });

  it("keeps both notes when a self-authored-only result also carries the usage note", () => {
    const text = textOf(
      buildResult([record({ role: "assistant", userId: null })], { usageNote: "USAGE NOTE" }),
    );
    expect(text).toContain(SELF_AUTHORED_ONLY_NOTE);
    expect(text).toContain("USAGE NOTE");
  });
});

describe("unquote", () => {
  it("strips the stray quotes a model wraps an argument in", () => {
    // Production, 2026-08-07: `author` arrived as the string `"R.K."`, quotes
    // included, and exact-name resolution missed a person who was right there.
    expect(unquote('"R.K."')).toBe("R.K.");
    expect(unquote("'Bea'")).toBe("Bea");
    expect(unquote(" `Cai` ")).toBe("Cai");
  });

  it("leaves an ordinary reference alone, including quotes inside it", () => {
    expect(unquote("Bea")).toBe("Bea");
    expect(unquote("@rok13")).toBe("@rok13");
    expect(unquote('the "boss"')).toBe('the "boss"');
  });

  it("does not strip a lone quote character", () => {
    expect(unquote('"')).toBe('"');
  });
});

describe("mergeMatches", () => {
  function match(over: Partial<SourceMessageMatch> & { id: number; score: number }): SourceMessageMatch {
    return {
      ...record({ id: over.id, sourceMessageId: String(over.id + 10) }),
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
