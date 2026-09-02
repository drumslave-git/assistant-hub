import { describe, expect, it } from "vitest";

import {
  botReactionSuffix,
  collectUserIds,
  fallbackSpeakerLabel,
  historyWindowStart,
  renderReplyRef,
  renderTranscript,
  renderTranscriptLine,
  toTranscriptLine,
  TRANSCRIPT_PREAMBLE,
} from "./format";
import type { ChatMessageRecord } from "./repository";

function record(over: Partial<ChatMessageRecord>): ChatMessageRecord {
  return {
    id: 1,
    chatRef: "tg:chat:5",
    sourceMessageId: "10",
    role: "user",
    userId: "100",
    content: "hello",
    replyToSourceMessageId: null,
    sentAt: "2026-07-12T10:00:00.000Z",
    editedAt: null,
    deletedAt: null,
    botReaction: null,
    createdAt: "2026-07-12T10:00:00.000Z",
    ...over,
  };
}

describe("historyWindowStart", () => {
  it("returns the instant 24 hours before now", () => {
    const start = historyWindowStart(new Date("2026-07-12T15:37:42.123Z"));
    expect(start.toISOString()).toBe("2026-07-11T15:37:42.123Z");
  });
});

describe("renderReplyRef", () => {
  it("renders a stored target as an id anchor", () => {
    expect(renderReplyRef({ kind: "anchor", sourceMessageId: "123" })).toBe("[reply to #123]");
  });

  it("appends the partial quote to an anchor", () => {
    expect(
      renderReplyRef({ kind: "anchor", sourceMessageId: "123", quote: "the sky is green" }),
    ).toBe('[reply to #123, quoting: "the sky is green"]');
  });

  it("inlines the full text of an unstored target, untrimmed", () => {
    const text = "a rather long quoted message that must never be trimmed ".repeat(5).trim();
    expect(renderReplyRef({ kind: "inline", label: "Alice (@alice)", text })).toBe(
      `[reply to Alice (@alice): "${text}"]`,
    );
  });

  it("marks an unstored target with no textual content as unavailable", () => {
    expect(renderReplyRef({ kind: "inline", label: "Alice (@alice)", text: null })).toBe(
      "[reply to Alice (@alice) (content not available)]",
    );
  });

  it("omits the sender when the unstored target has none", () => {
    expect(renderReplyRef({ kind: "inline", label: null, text: "hi" })).toBe('[reply to: "hi"]');
  });
});

describe("renderTranscriptLine", () => {
  it("renders an anchored, labelled line", () => {
    const line = renderTranscriptLine({
      sourceMessageId: "42",
      label: "Alice (@alice)",
      content: "hello all",
    });
    expect(line).toBe("[#42] Alice (@alice): hello all");
  });

  it("places the reply marker between the label and the content", () => {
    const line = renderTranscriptLine({
      sourceMessageId: "43",
      label: "Bob (@bob)",
      replyRef: { kind: "anchor", sourceMessageId: "42" },
      content: "@bot tell him he is wrong",
    });
    expect(line).toBe("[#43] Bob (@bob) [reply to #42]: @bot tell him he is wrong");
  });
});

describe("toTranscriptLine", () => {
  it("labels a user row with the resolved speaker label", () => {
    const line = toTranscriptLine(record({ content: "hey", userId: "100" }), {
      speakerLabels: new Map([["100", "Alice (@alice)"]]),
    });
    expect(line).toBe("[#10] Alice (@alice): hey");
  });

  it("falls back to a user-id label when the speaker is unknown", () => {
    const line = toTranscriptLine(record({ content: "hey", userId: "999" }), {
      speakerLabels: new Map([["100", "Alice"]]),
    });
    expect(line).toBe("[#10] User 999: hey");
  });

  it("labels an assistant row with the bot label", () => {
    const line = toTranscriptLine(
      record({ role: "assistant", userId: null, content: "hi back", replyToSourceMessageId: "9" }),
      { botLabel: "You (@MyBot)" },
    );
    expect(line).toBe("[#10] You (@MyBot) [reply to #9]: hi back");
  });

  it("renders a stored reply target as an id anchor", () => {
    const line = toTranscriptLine(record({ content: "so wrong", replyToSourceMessageId: "7" }), {
      speakerLabels: new Map([["100", "Bob"]]),
    });
    expect(line).toBe("[#10] Bob [reply to #7]: so wrong");
  });

  it("appends a media suffix for a message that carries an image", () => {
    const line = toTranscriptLine(record({ content: "look", userId: "100" }), {
      speakerLabels: new Map([["100", "Alice"]]),
      mediaSuffixes: new Map([["10", " [photo: a red car]"]]),
    });
    expect(line).toBe("[#10] Alice: look [photo: a red car]");
  });

  it("ignores a media suffix for an unrelated message id", () => {
    const line = toTranscriptLine(record({ content: "hi", userId: "100" }), {
      speakerLabels: new Map([["100", "Alice"]]),
      mediaSuffixes: new Map([["999", " [photo]"]]),
    });
    expect(line).toBe("[#10] Alice: hi");
  });

  it("renders the bot's reaction on the line, after any media suffix", () => {
    // The reaction is state on the record itself — this one renderer is what
    // every transcript consumer reads, which is what keeps the bot from
    // denying a reaction it set (2026-08-15).
    const line = toTranscriptLine(
      record({ content: "look", userId: "100", botReaction: "👍" }),
      {
        speakerLabels: new Map([["100", "Alice"]]),
        mediaSuffixes: new Map([["10", " [photo: a red car]"]]),
      },
    );
    expect(line).toBe("[#10] Alice: look [photo: a red car] [you reacted: 👍]");
  });
});

describe("botReactionSuffix", () => {
  it("is the annotation for a reacted record and empty otherwise", () => {
    expect(botReactionSuffix(record({ botReaction: "🔥" }))).toBe(" [you reacted: 🔥]");
    expect(botReactionSuffix(record({}))).toBe("");
  });
});

describe("renderTranscript", () => {
  it("returns null when there are no rows", () => {
    expect(renderTranscript([], {})).toBeNull();
  });

  it("renders the preamble plus one line per row, in order", () => {
    const transcript = renderTranscript(
      [
        record({ sourceMessageId: "1", content: "earth is flat", userId: "100" }),
        record({
          id: 2,
          sourceMessageId: "2",
          content: "no it is not",
          userId: "200",
          replyToSourceMessageId: "1",
        }),
        record({ id: 3, sourceMessageId: "3", role: "assistant", userId: null, content: "indeed" }),
      ],
      { speakerLabels: new Map([["100", "Alice"], ["200", "Bob"]]), botLabel: "You (@MyBot)" },
    );
    expect(transcript).toBe(
      `${TRANSCRIPT_PREAMBLE}\n\n` +
        "[#1] Alice: earth is flat\n" +
        "[#2] Bob [reply to #1]: no it is not\n" +
        "[#3] You (@MyBot): indeed",
    );
  });

  it("marks the bot's own lines as non-evidence in the preamble", () => {
    expect(TRANSCRIPT_PREAMBLE).toContain(
      "your own lines are not evidence of anything beyond having said it",
    );
    expect(TRANSCRIPT_PREAMBLE).toContain("may be wrong or invented");
  });
});

describe("fallbackSpeakerLabel", () => {
  it("uses the user id when known, a bare label otherwise", () => {
    expect(fallbackSpeakerLabel("42")).toBe("User 42");
    expect(fallbackSpeakerLabel(null)).toBe("User");
  });
});

describe("collectUserIds", () => {
  it("returns distinct non-null sender ids", () => {
    const ids = collectUserIds([
      record({ userId: "1" }),
      record({ userId: "2" }),
      record({ userId: "1" }),
      record({ role: "assistant", userId: null }),
    ]);
    expect(ids.sort()).toEqual(["1", "2"]);
  });
});
