import { describe, expect, it } from "vitest";

import { isExcludedTerm, normalizeExclusionTerm } from "./exclusions";

describe("normalizeExclusionTerm", () => {
  it("folds case, trims, and collapses inner whitespace", () => {
    expect(normalizeExclusionTerm("  Георгій  ")).toBe("георгій");
    expect(normalizeExclusionTerm("Jean\t Luc")).toBe("jean luc");
  });

  // The guard that keeps `no-linguistic-heuristics-in-code` honest: normalization
  // is mechanical only. A Cyrillic spelling and a Latin one stay different words,
  // and deciding they mean the same person is the model's job, never this code's.
  it("does not transliterate, romanize, or strip diacritics", () => {
    expect(normalizeExclusionTerm("Георгій")).not.toBe(normalizeExclusionTerm("Heorhii"));
    expect(normalizeExclusionTerm("Renée")).not.toBe(normalizeExclusionTerm("Renee"));
  });
});

describe("isExcludedTerm", () => {
  const exclusions = ["Георгій", "  Ivan  "];

  it("matches an excluded word regardless of case and surrounding space", () => {
    expect(isExcludedTerm("георгій", exclusions)).toBe(true);
    expect(isExcludedTerm(" IVAN ", exclusions)).toBe(true);
  });

  it("matches whole words only — an inflected form is the model's call", () => {
    expect(isExcludedTerm("Георгію", exclusions)).toBe(false);
    expect(isExcludedTerm("Ivanov", exclusions)).toBe(false);
  });

  it("is false for an empty word or an empty list", () => {
    expect(isExcludedTerm("  ", exclusions)).toBe(false);
    expect(isExcludedTerm("Георгій", [])).toBe(false);
  });
});
