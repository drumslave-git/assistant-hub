import { describe, expect, it } from "vitest";

import { parsePrefsJson } from "./analyze";

describe("parsePrefsJson", () => {
  it("parses a bare JSON object", () => {
    expect(parsePrefsJson('{"likes": "short answers", "dislikes": "rambling"}')).toEqual({
      likes: "short answers",
      dislikes: "rambling",
    });
  });

  it("tolerates code fences and surrounding prose", () => {
    const content = 'Here you go:\n```json\n{"likes": "a", "dislikes": "b"}\n```\nDone.';
    expect(parsePrefsJson(content)).toEqual({ likes: "a", dislikes: "b" });
  });

  it("rejects non-object and wrongly-shaped output", () => {
    expect(parsePrefsJson("no json here")).toBeNull();
    expect(parsePrefsJson('{"likes": 1, "dislikes": "b"}')).toBeNull();
    expect(parsePrefsJson('{"likes": "a"}')).toBeNull();
    expect(parsePrefsJson("{broken")).toBeNull();
  });
});
