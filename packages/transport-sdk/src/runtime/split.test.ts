import { describe, expect, it } from "vitest";

import { splitMessage } from "./split";

/** The two real caps in the wild, so the cap is exercised as an argument. */
const TELEGRAM = 4096;
const DISCORD = 2000;

describe("splitMessage", () => {
  it("returns short text as a single chunk, and empty text as none", () => {
    expect(splitMessage("  hello  ", TELEGRAM)).toEqual(["hello"]);
    expect(splitMessage("   ", TELEGRAM)).toEqual([]);
  });

  it("splits at a paragraph boundary and loses no content", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(3000);
    expect(splitMessage(`${a}\n\n${b}`, TELEGRAM)).toEqual([a, b]);
  });

  it("falls back to a sentence boundary when there are no line breaks", () => {
    const sentence = "This is a fairly ordinary sentence about nothing much. ";
    const text = sentence.repeat(150).trim(); // ~8.4k chars, no newlines
    const chunks = splitMessage(text, TELEGRAM);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM);
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
    const text = "x".repeat(TELEGRAM * 2 + 10);
    expect(splitMessage(text, TELEGRAM).map((c) => c.length)).toEqual([TELEGRAM, TELEGRAM, 10]);
    expect(splitMessage(text, TELEGRAM).join("")).toBe(text);
  });

  it("obeys whichever cap it is given", () => {
    const text = ("Some words here and there. ".repeat(40) + "\n\n").repeat(20).trim();
    for (const max of [TELEGRAM, DISCORD, 100]) {
      const chunks = splitMessage(text, max);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(max);
      expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    }
  });

  it("cuts the same text more often under a smaller cap", () => {
    const text = "Sentence about nothing. ".repeat(300).trim();
    expect(splitMessage(text, DISCORD).length).toBeGreaterThan(
      splitMessage(text, TELEGRAM).length,
    );
  });
});
