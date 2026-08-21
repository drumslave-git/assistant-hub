import { describe, expect, it } from "vitest";

import {
  createPersonalitySchema,
  setActivePersonalitySchema,
  updatePersonalitySchema,
} from "./schema";

describe("createPersonalitySchema", () => {
  it("requires a name, trims it, and defaults the prompt to empty", () => {
    expect(createPersonalitySchema.parse({ name: "  Pirate  " })).toEqual({
      name: "Pirate",
      prompt: "",
    });
    expect(createPersonalitySchema.safeParse({ name: "" }).success).toBe(false);
    expect(createPersonalitySchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createPersonalitySchema.safeParse({}).success).toBe(false);
  });

  it("trims the prompt and bounds name/prompt length", () => {
    expect(createPersonalitySchema.parse({ name: "P", prompt: "  be terse  " })).toEqual({
      name: "P",
      prompt: "be terse",
    });
    expect(createPersonalitySchema.safeParse({ name: "x".repeat(65) }).success).toBe(false);
    expect(
      createPersonalitySchema.safeParse({ name: "P", prompt: "x".repeat(32_001) }).success,
    ).toBe(false);
  });
});

describe("updatePersonalitySchema", () => {
  it("accepts a partial update and rejects an empty one", () => {
    expect(updatePersonalitySchema.parse({ name: "New" })).toEqual({ name: "New" });
    expect(updatePersonalitySchema.parse({ prompt: "x" })).toEqual({ prompt: "x" });
    expect(updatePersonalitySchema.safeParse({}).success).toBe(false);
  });
});

describe("setActivePersonalitySchema", () => {
  it("accepts an id or null", () => {
    expect(setActivePersonalitySchema.parse({ personalityId: "abc" })).toEqual({
      personalityId: "abc",
    });
    expect(setActivePersonalitySchema.parse({ personalityId: null })).toEqual({
      personalityId: null,
    });
    expect(setActivePersonalitySchema.safeParse({ personalityId: "" }).success).toBe(false);
  });
});
