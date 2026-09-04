import { describe, expect, it } from "vitest";

import { withoutAddressing } from "./self-link";

/**
 * A link code has to be the WHOLE message — that is what makes it safe to
 * redeem one on sight. On a platform where addressing a bot in a shared
 * channel requires mentioning it, the code is never alone, so the addressing
 * comes off first (user decision, 2026-09-04). What must NOT survive that is
 * the property the rule was for: a code sitting inside a sentence is not a
 * redemption.
 */

const CODE = /^link-[a-z0-9]{8}$/;
const redeems = (text: string) => CODE.test(withoutAddressing(text.trim()).toLowerCase());

describe("withoutAddressing", () => {
  it("leaves a bare code alone", () => {
    expect(redeems("link-bgaam3b9")).toBe(true);
    expect(redeems("  LINK-BGAAM3B9  ")).toBe(true);
  });

  it("accepts a code addressed to the bot, which is the only way in a channel", () => {
    expect(redeems("@TCloud link-bgaam3b9")).toBe(true);
    expect(redeems("@some_bot link-bgaam3b9")).toBe(true);
    // Several people addressed at once still leaves the code alone.
    expect(redeems("@one @two link-bgaam3b9")).toBe(true);
  });

  it("still refuses a code that is part of a sentence", () => {
    // The whole point of the anchor: mentioning your code must not spend it.
    expect(redeems("my code is link-bgaam3b9")).toBe(false);
    expect(redeems("@TCloud my code is link-bgaam3b9")).toBe(false);
    expect(redeems("@TCloud link-bgaam3b9 thanks")).toBe(false);
  });

  it("strips only a leading run of mentions", () => {
    expect(withoutAddressing("@a @b hello @c")).toBe("hello @c");
    expect(withoutAddressing("hello @a")).toBe("hello @a");
    // Nothing to strip, and an @ glued to the code is not addressing.
    expect(withoutAddressing("link-bgaam3b9@evil")).toBe("link-bgaam3b9@evil");
  });
});
