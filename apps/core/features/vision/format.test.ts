import { describe, expect, it } from "vitest";

import { sampleFrames, sampleImage } from "@/test/__mocks__/vision";
import {
  buildVisionContent,
  frameSequenceHint,
  mediaKindLabel,
  renderMediaSuffix,
  toImagePart,
  toVisionParts,
} from "./format";
import type { MediaAnnotation } from "./types";

describe("mediaKindLabel", () => {
  it("maps kinds to human labels", () => {
    expect(mediaKindLabel("photo")).toBe("photo");
    expect(mediaKindLabel("image_document")).toBe("image");
    expect(mediaKindLabel("animation")).toBe("GIF");
  });
});

describe("renderMediaSuffix", () => {
  const base: MediaAnnotation = { kind: "photo", status: "pending", description: null };

  it("shows the description once described", () => {
    expect(
      renderMediaSuffix({ ...base, status: "described", description: "a red car" }),
    ).toBe(" [photo: a red car]");
  });

  it("shows a bare kind marker while pending", () => {
    expect(renderMediaSuffix(base)).toBe(" [photo]");
  });

  it("flags unavailable media", () => {
    expect(renderMediaSuffix({ ...base, status: "unavailable" })).toBe(" [photo unavailable]");
  });
});

describe("toImagePart / buildVisionContent", () => {
  it("builds an image_url data URL part", () => {
    expect(toImagePart({ base64: "ABC", mimeHint: "image/jpeg" })).toEqual({
      type: "image_url",
      image_url: { url: "data:image/jpeg;base64,ABC" },
    });
  });

  it("puts the text first, then the image part for a single image", () => {
    const content = buildVisionContent("what is this?", [sampleImage]);
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content).toHaveLength(2);
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } });
  });

  it("stands in a default instruction when there is no text", () => {
    const content = buildVisionContent("   ", [sampleImage]);
    expect(content[0]).toEqual({ type: "text", text: "Respond to this image." });
  });
});

describe("toVisionParts (ordered frame sequence)", () => {
  it("returns a single unlabeled image part for one image", () => {
    const parts = toVisionParts([sampleImage]);
    expect(parts).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } }]);
  });

  it("labels and interleaves each frame for a sequence", () => {
    const parts = toVisionParts(sampleFrames);
    // [Frame 1 of 3:, imgA, Frame 2 of 3:, imgB, Frame 3 of 3:, imgC]
    expect(parts).toHaveLength(6);
    expect(parts[0]).toEqual({ type: "text", text: "Frame 1 of 3:" });
    expect(parts[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,A" } });
    expect(parts[4]).toEqual({ type: "text", text: "Frame 3 of 3:" });
  });
});

describe("frameSequenceHint", () => {
  it("describes a single frame plainly", () => {
    expect(frameSequenceHint("video", 1)).toContain("still frame");
    expect(frameSequenceHint("animation", 1)).toContain("GIF");
  });

  it("tells the model a multi-frame set is one ordered clip, not separate images", () => {
    const hint = frameSequenceHint("video", 10);
    expect(hint).toContain("10 images");
    expect(hint).toContain("chronological order");
    expect(hint).toMatch(/NOT|not separate/);
    expect(frameSequenceHint("animation", 4)).toContain("GIF");
  });
});
