import { describe, expect, it } from "vitest";

import { splitMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from "./split";

describe("splitMessage", () => {
  it("returns short text as a single chunk, and empty text as none", () => {
    expect(splitMessage("  hello  ")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("splits at a paragraph boundary and loses no content", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    const chunks = splitMessage(`${a}\n\n${b}`);
    expect(chunks).toEqual([a, b]);
  });

  it("falls back to a sentence boundary when there are no line breaks", () => {
    const sentence = "This is a fairly ordinary sentence about nothing much. ";
    const text = sentence.repeat(150).trim(); // ~8.4k chars, no newlines
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
      expect(chunk.length).toBeGreaterThan(0);
    }
    // Every chunk except possibly the last ends where a sentence ended.
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.endsWith(".")).toBe(true);
    }
    // Nothing was lost: rejoining restores the original text.
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-cuts unbreakable text at the limit", () => {
    const text = "x".repeat(TELEGRAM_MAX_MESSAGE_LENGTH * 2 + 10);
    const chunks = splitMessage(text);
    expect(chunks.map((c) => c.length)).toEqual([
      TELEGRAM_MAX_MESSAGE_LENGTH,
      TELEGRAM_MAX_MESSAGE_LENGTH,
      10,
    ]);
    expect(chunks.join("")).toBe(text);
  });

  it("never emits a chunk over the limit for mixed content", () => {
    const text = ("Some words here and there. ".repeat(40) + "\n\n").repeat(20).trim();
    for (const chunk of splitMessage(text)) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
  });
});
