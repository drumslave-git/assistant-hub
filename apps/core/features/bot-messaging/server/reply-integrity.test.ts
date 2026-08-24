import { describe, expect, it } from "vitest";

import {
  REPLY_INTEGRITY_DIRECTIVE,
  REPLY_NOT_PRODUCED_REPLY,
  checkReplyIntegrity,
} from "./reply-integrity";

/**
 * The gate's pure half. The leaked fixtures below are verbatim heads of real
 * answers this endpoint produced (probe run of 2026-08-24 against the exact
 * request behind trace `3491c387`) — the point of the check is that these
 * never reach a chat, and that ordinary replies are untouched.
 */

/** Leaked deliberation that opened with the transcript anchor (9/10 of them). */
const LEAK_ANCHOR_FIRST =
  '[#616] drumslave (@drumslave): як тебе звуть? (What is your name?)\n' +
  'In message [#611], I said "My name is IgorTCloudBot."\n' +
  "The user is asking the same question again, perhaps because they want a more natural answer";

/** Leaked deliberation that opened in prose and cited anchors further in. */
const LEAK_ANCHOR_LATER =
  'The user is asking "як тебе звуть?" which means "what is your name?".\n\n' +
  "Looking at the history:\n[#610] drumslave asked, and I replied [#611].";

describe("checkReplyIntegrity", () => {
  it("passes an ordinary reply", () => {
    expect(checkReplyIntegrity({ content: "I'm Anna.", finishReason: "stop" })).toEqual({
      ok: true,
    });
  });

  it("catches deliberation written in the input-only transcript format", () => {
    for (const content of [LEAK_ANCHOR_FIRST, LEAK_ANCHOR_LATER]) {
      const verdict = checkReplyIntegrity({ content, finishReason: "stop" });
      expect(verdict.ok).toBe(false);
      expect(verdict.violation).toBe("transcript_format");
      // The evidence is the anchor itself, quoted for the trace.
      expect(content).toContain(verdict.evidence!);
    }
  });

  it("catches an answer cut off at the token cap", () => {
    const verdict = checkReplyIntegrity({
      content: "It is a long answer that never ends because it ran into the",
      finishReason: "length",
    });
    expect(verdict).toMatchObject({ ok: false, violation: "truncated" });
  });

  it("catches raw chat-template channel markers", () => {
    // Seen live in a user-facing answer when the model malformed the sequence
    // and the server could not parse it out.
    const verdict = checkReplyIntegrity({
      content: "<|channel>thought\n<channel|><channel|>here's a joke for you",
      finishReason: "stop",
    });
    expect(verdict).toMatchObject({ ok: false, violation: "channel_markers" });
  });

  it("leaves the bot's own citation form alone — only the bracketed anchor is input-only", () => {
    // `#611` is how the bot links to a message (the source resolves it against
    // its mirror); flagging it would break every citation the bot makes.
    expect(
      checkReplyIntegrity({ content: "You asked me that in #611, same answer.", finishReason: "stop" }),
    ).toEqual({ ok: true });
  });

  it("treats an absent finish_reason as normal", () => {
    // A provider that reports nothing cannot report truncation.
    expect(checkReplyIntegrity({ content: "Sure." })).toEqual({ ok: true });
  });

  it("names the mistake in the directive, and offers the short answer as enough", () => {
    expect(REPLY_INTEGRITY_DIRECTIVE).toMatch(/working-out/i);
    expect(REPLY_INTEGRITY_DIRECTIVE).toMatch(/\[#123\]/);
    expect(REPLY_INTEGRITY_DIRECTIVE).toMatch(/one short sentence/i);
  });

  it("labels the suppression notice as the system, not the persona", () => {
    expect(REPLY_NOT_PRODUCED_REPLY.startsWith("⚠️ System:")).toBe(true);
  });
});
