import { describe, expect, it } from "vitest";

import { updateGroupLanguageSchema, updateGroupNotesSchema } from "./schema";

describe("updateGroupNotesSchema", () => {
  it("trims notes and keeps non-empty content", () => {
    const parsed = updateGroupNotesSchema.parse({ notes: "  Family chat  " });
    expect(parsed.notes).toBe("Family chat");
  });

  it("clears blank/whitespace-only notes to null", () => {
    expect(updateGroupNotesSchema.parse({ notes: "   " }).notes).toBeNull();
    expect(updateGroupNotesSchema.parse({ notes: "" }).notes).toBeNull();
  });

  it("rejects notes longer than the limit", () => {
    const result = updateGroupNotesSchema.safeParse({ notes: "x".repeat(2001) });
    expect(result.success).toBe(false);
  });
});

describe("updateGroupLanguageSchema", () => {
  it("normalizes a language name", () => {
    expect(updateGroupLanguageSchema.parse({ language: "  Ukrainian " }).language).toBe("Ukrainian");
  });

  it("clears blank language to null", () => {
    expect(updateGroupLanguageSchema.parse({ language: "" }).language).toBeNull();
    expect(updateGroupLanguageSchema.parse({ language: "   " }).language).toBeNull();
  });
});
