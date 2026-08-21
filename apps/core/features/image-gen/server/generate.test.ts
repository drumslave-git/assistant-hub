import { describe, expect, it, vi } from "vitest";

import { runImageGeneration } from "./generate";

/**
 * The generation core's contract is "never throw": a picture the user asked for in
 * passing must not be able to abort the whole reply. Every failure has to come back
 * as an `ok: false` outcome the model can talk about.
 */

describe("runImageGeneration", () => {
  it("returns the images and a success context", async () => {
    const generate = vi.fn().mockResolvedValue(["AAAA", "BBBB"]);

    const result = await runImageGeneration({ prompt: "a red car", size: [512, 512] }, { generate });

    expect(result.ok).toBe(true);
    expect(result.images).toEqual(["AAAA", "BBBB"]);
    expect(result.size).toEqual([512, 512]);
    expect(result.context).toContain("2 images");
    expect(generate).toHaveBeenCalledWith("a red car", [512, 512]);
  });

  it("defaults the size when the model does not ask for one", async () => {
    const generate = vi.fn().mockResolvedValue(["AAAA"]);

    const result = await runImageGeneration({ prompt: "a cat" }, { generate });

    expect(result.size).toEqual([1024, 1024]);
    expect(generate).toHaveBeenCalledWith("a cat", [1024, 1024]);
  });

  it("trims the prompt before generating", async () => {
    const generate = vi.fn().mockResolvedValue(["AAAA"]);

    await runImageGeneration({ prompt: "  a cat  " }, { generate });

    expect(generate).toHaveBeenCalledWith("a cat", [1024, 1024]);
  });

  it("rejects an empty prompt without calling the provider", async () => {
    const generate = vi.fn();

    const result = await runImageGeneration({ prompt: "   " }, { generate });

    expect(result.ok).toBe(false);
    expect(result.images).toEqual([]);
    expect(result.reason).toBe("empty prompt");
    expect(generate).not.toHaveBeenCalled();
  });

  it("turns a provider failure into an outcome rather than throwing", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("endpoint unreachable"));

    const result = await runImageGeneration({ prompt: "a cat" }, { generate });

    expect(result.ok).toBe(false);
    expect(result.images).toEqual([]);
    expect(result.reason).toBe("endpoint unreachable");
    // The model must be told plainly that nothing was sent.
    expect(result.context).toContain("endpoint unreachable");
    expect(result.context).toContain("No image was sent");
  });
});
