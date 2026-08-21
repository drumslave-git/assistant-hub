import { describe, expect, it } from "vitest";

import { formatKnownUserLabel, formatUserContext } from "./format";

describe("formatKnownUserLabel", () => {
  it("combines name and @username when both are present", () => {
    expect(
      formatKnownUserLabel({ firstName: "Ada", lastName: "L", username: "testuser", userId: "1" }),
    ).toBe("Ada L (@testuser)");
  });

  it("falls back to name, then @username, then id", () => {
    expect(formatKnownUserLabel({ firstName: "Ann", lastName: null, username: null, userId: "1" })).toBe(
      "Ann",
    );
    expect(formatKnownUserLabel({ firstName: null, lastName: null, username: "ann", userId: "1" })).toBe(
      "@ann",
    );
    expect(formatKnownUserLabel({ firstName: null, lastName: null, username: null, userId: "1" })).toBe(
      "User 1",
    );
  });
});

describe("formatUserContext", () => {
  it("names who the bot is talking to, with identity facts only (no tool references)", () => {
    const block = formatUserContext({ label: "Ada L (@testuser)", aliases: [] });
    expect(block).toContain("private, one-on-one Telegram chat with Ada L (@testuser).");
    // No aliases → no "also known as" clause.
    expect(block).not.toContain("also known as");
    // Identity context stays tool-agnostic — the prompt must not name tools.
    expect(block).not.toContain("update_user_aliases");
  });

  it("lists known aliases when present", () => {
    const block = formatUserContext({ label: "Ada", aliases: ["Ace", "Nova"] });
    expect(block).toContain("They are also known as: Ace, Nova.");
  });
});
