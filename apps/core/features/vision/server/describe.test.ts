import { describe, expect, it } from "vitest";

import { sampleImage } from "@/test/__mocks__/vision";
import { VISION_DESCRIBE_SYSTEM } from "../describe-prompt";
import { buildDescribeMessages } from "./describe";

describe("buildDescribeMessages", () => {
  it("pairs the describe system prompt with a vision user turn", () => {
    const [system, user] = buildDescribeMessages([sampleImage], null);
    expect(system).toEqual({ role: "system", content: VISION_DESCRIBE_SYSTEM });
    expect(user.role).toBe("user");
    const parts = user.content as { type: string; image_url?: { url: string } }[];
    expect(parts[0].type).toBe("text");
    expect(parts[1].image_url?.url).toBe("data:image/jpeg;base64,A");
  });

  it("folds a sticker hint into the user text", () => {
    const [, user] = buildDescribeMessages([sampleImage], "Sticker emoji: 😀");
    const parts = user.content as { type: string; text?: string }[];
    expect(parts[0].text).toContain("😀");
  });
});
