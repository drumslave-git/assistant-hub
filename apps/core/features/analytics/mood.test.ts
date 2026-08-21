import { describe, expect, it } from "vitest";

import { clampMoodScore, moodLabelForScore } from "./mood";

describe("clampMoodScore", () => {
  it("clamps to the 0–100 integer range", () => {
    expect(clampMoodScore(150)).toBe(100);
    expect(clampMoodScore(-5)).toBe(0);
    expect(clampMoodScore(60.4)).toBe(60);
    expect(clampMoodScore(60.6)).toBe(61);
  });

  it("falls back to neutral for non-finite input", () => {
    expect(clampMoodScore(Number.NaN)).toBe(50);
    expect(clampMoodScore(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe("moodLabelForScore", () => {
  it("labels each band", () => {
    expect(moodLabelForScore(90)).toBe("very positive");
    expect(moodLabelForScore(65)).toBe("positive");
    expect(moodLabelForScore(50)).toBe("neutral");
    expect(moodLabelForScore(30)).toBe("tense");
    expect(moodLabelForScore(10)).toBe("negative");
  });
});
