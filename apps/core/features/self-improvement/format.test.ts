import { describe, expect, it } from "vitest";

import { formatPreferencesContext } from "./format";

describe("formatPreferencesContext", () => {
  it("renders likes + dislikes with the user's label and an instruction", () => {
    const out = formatPreferencesContext({
      label: "Alice (@alice)",
      likes: "short answers",
      dislikes: "emoji walls",
    });
    expect(out).toContain("Communication preferences of Alice (@alice)");
    expect(out).toContain("- They like: short answers");
    expect(out).toContain("- They dislike: emoji walls");
    expect(out).toContain("Adapt the style");
  });

  it("omits an empty side", () => {
    const out = formatPreferencesContext({ label: "A", likes: "humor", dislikes: "  " });
    expect(out).toContain("They like: humor");
    expect(out).not.toContain("They dislike");
  });

  it("returns null when both sides are blank", () => {
    expect(formatPreferencesContext({ label: "A", likes: " ", dislikes: "" })).toBeNull();
  });
});
