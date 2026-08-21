import { describe, expect, it } from "vitest";

import { formatImageFailure, formatImageSuccess } from "./format";

/**
 * The result text is the model's *only* evidence of what happened to an image it
 * asked for — it never sees the bytes. So these assertions are about the two lies
 * the text exists to prevent: describing an image the model cannot see, and
 * claiming an image was sent when none was.
 */

describe("formatImageSuccess", () => {
  it("states the image is delivered and forbids describing it", () => {
    const text = formatImageSuccess(1, [1024, 1024]);
    expect(text).toContain("delivered it to the chat");
    expect(text).toContain("1024x1024");
    // The model never saw the image; anything it says about the contents is invented.
    expect(text).toMatch(/not seen/i);
    expect(text).toMatch(/do not describe/i);
  });

  it("agrees in number for multiple images", () => {
    const text = formatImageSuccess(3, [512, 512]);
    expect(text).toContain("3 images");
    expect(text).toContain("delivered them");
    expect(text).not.toContain("delivered it");
  });
});

describe("formatImageFailure", () => {
  it("leads with the reason and says nothing was sent", () => {
    const text = formatImageFailure("a red car", "endpoint unreachable");
    expect(text.startsWith("Image generation failed: endpoint unreachable")).toBe(true);
    expect(text).toContain('(prompt: "a red car")');
    expect(text).toContain("No image was sent");
    expect(text).toMatch(/do not claim you made one/i);
  });

  it("truncates a long prompt but keeps the reason intact", () => {
    const prompt = "a ".repeat(200);
    const text = formatImageFailure(prompt, "provider timeout");
    expect(text).toContain("provider timeout");
    expect(text).toContain("…");
    // The reason is the actionable part, so it must survive ahead of the echo.
    expect(text.indexOf("provider timeout")).toBeLessThan(text.indexOf("(prompt:"));
  });

  it("omits the prompt echo entirely when there is no prompt", () => {
    const text = formatImageFailure("", "the prompt was empty");
    expect(text).not.toContain("(prompt:");
    expect(text).toContain("No image was sent");
  });
});
