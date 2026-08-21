import { describe, expect, it } from "vitest";

import type { ReactionType, ReactionTypeEmoji } from "@grammyjs/types";

import { detectAddedThumb } from "./process-reaction";

const emoji = (value: ReactionTypeEmoji["emoji"]): ReactionType => ({
  type: "emoji",
  emoji: value,
});

describe("detectAddedThumb", () => {
  it("detects a freshly added 👍 / 👎", () => {
    expect(detectAddedThumb({ old_reaction: [], new_reaction: [emoji("👍")] })).toBe("up");
    expect(detectAddedThumb({ old_reaction: [], new_reaction: [emoji("👎")] })).toBe("down");
  });

  it("ignores a reaction removal", () => {
    expect(detectAddedThumb({ old_reaction: [emoji("👍")], new_reaction: [] })).toBeNull();
  });

  it("ignores updates where the thumb was already present", () => {
    expect(
      detectAddedThumb({
        old_reaction: [emoji("👍")],
        new_reaction: [emoji("👍"), emoji("🔥")],
      }),
    ).toBeNull();
  });

  it("ignores non-thumb emoji and custom reactions", () => {
    expect(detectAddedThumb({ old_reaction: [], new_reaction: [emoji("🔥")] })).toBeNull();
    expect(
      detectAddedThumb({
        old_reaction: [],
        new_reaction: [{ type: "custom_emoji", custom_emoji_id: "x" }],
      }),
    ).toBeNull();
  });

  it("detects a thumb swap (👍 → 👎) as the newly added thumb", () => {
    expect(
      detectAddedThumb({ old_reaction: [emoji("👍")], new_reaction: [emoji("👎")] }),
    ).toBe("down");
  });
});
