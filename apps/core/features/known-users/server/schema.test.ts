import { describe, expect, it } from "vitest";

import { updateAliasesSchema, updateUserLanguageSchema } from "./schema";

describe("updateAliasesSchema", () => {
  it("trims entries and drops blanks", () => {
    expect(updateAliasesSchema.parse({ aliases: ["  Ann ", "", "  "] })).toEqual({
      aliases: ["Ann"],
    });
  });

  it("collapses case-insensitive duplicates, keeping first form/order", () => {
    expect(updateAliasesSchema.parse({ aliases: ["Boss", "boss", "Chief"] })).toEqual({
      aliases: ["Boss", "Chief"],
    });
  });

  it("accepts an empty list (clears aliases)", () => {
    expect(updateAliasesSchema.parse({ aliases: [] })).toEqual({ aliases: [] });
  });

  it("rejects too many aliases", () => {
    const many = Array.from({ length: 21 }, (_, i) => `alias${i}`);
    expect(updateAliasesSchema.safeParse({ aliases: many }).success).toBe(false);
  });

  it("rejects an overly long alias", () => {
    expect(updateAliasesSchema.safeParse({ aliases: ["x".repeat(61)] }).success).toBe(false);
  });
});

describe("updateUserLanguageSchema", () => {
  it("normalizes a language name", () => {
    expect(updateUserLanguageSchema.parse({ language: "  Ukrainian " }).language).toBe("Ukrainian");
  });

  it("clears blank language to null", () => {
    expect(updateUserLanguageSchema.parse({ language: "" }).language).toBeNull();
  });
});
