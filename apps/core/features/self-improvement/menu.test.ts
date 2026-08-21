import { describe, expect, it } from "vitest";

import {
  buildMenuKeyboard,
  decodeMenuCallback,
  encodeMenuCallback,
  menuText,
  OTHER_OPTION,
} from "./menu";
import { DISLIKE_OPTIONS, LIKE_OPTIONS, OTHER_OPTION_LABEL } from "./options";

const FEEDBACK_ID = "3f6f6f6a-1111-4222-8333-444455556666";

describe("menu callback codec", () => {
  it("round-trips a predefined option index", () => {
    const data = encodeMenuCallback(FEEDBACK_ID, 3);
    expect(decodeMenuCallback(data)).toEqual({ feedbackId: FEEDBACK_ID, option: 3 });
  });

  it("round-trips the Other option", () => {
    const data = encodeMenuCallback(FEEDBACK_ID, OTHER_OPTION);
    expect(decodeMenuCallback(data)).toEqual({ feedbackId: FEEDBACK_ID, option: OTHER_OPTION });
  });

  it("stays under Telegram's 64-byte callback_data cap", () => {
    for (const option of [0, 4, OTHER_OPTION] as const) {
      expect(Buffer.byteLength(encodeMenuCallback(FEEDBACK_ID, option))).toBeLessThanOrEqual(64);
    }
  });

  it("rejects foreign or malformed callback data", () => {
    expect(decodeMenuCallback("something-else")).toBeNull();
    expect(decodeMenuCallback("task:abc:1")).toBeNull();
    expect(decodeMenuCallback("fb:only-two")).toBeNull();
    expect(decodeMenuCallback(`fb:${FEEDBACK_ID}:nope`)).toBeNull();
    expect(decodeMenuCallback(`fb:${FEEDBACK_ID}:-1`)).toBeNull();
    expect(decodeMenuCallback("fb::1")).toBeNull();
  });
});

describe("buildMenuKeyboard", () => {
  it("renders the five 👍 options plus Other, one per row", () => {
    const keyboard = buildMenuKeyboard("up", FEEDBACK_ID);
    expect(keyboard).toHaveLength(LIKE_OPTIONS.length + 1);
    expect(keyboard.map((row) => row[0].text)).toEqual([...LIKE_OPTIONS, OTHER_OPTION_LABEL]);
    expect(keyboard[0][0].callbackData).toBe(encodeMenuCallback(FEEDBACK_ID, 0));
    expect(keyboard.at(-1)![0].callbackData).toBe(encodeMenuCallback(FEEDBACK_ID, OTHER_OPTION));
  });

  it("renders the 👎 options for a down reaction", () => {
    const keyboard = buildMenuKeyboard("down", FEEDBACK_ID);
    expect(keyboard.map((row) => row[0].text)).toEqual([...DISLIKE_OPTIONS, OTHER_OPTION_LABEL]);
  });
});

describe("menu texts", () => {
  it("asks what was liked/disliked per reaction", () => {
    expect(menuText("up")).toContain("like");
    expect(menuText("down")).toContain("wrong");
  });
});
