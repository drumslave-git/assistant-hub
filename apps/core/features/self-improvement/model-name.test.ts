import { describe, expect, it } from "vitest";

import { normalizeModelName, UNKNOWN_MODEL } from "./model-name";

describe("normalizeModelName", () => {
  it("keeps a plain model name (with its tag) untouched", () => {
    expect(normalizeModelName("gemma3:12b")).toBe("gemma3:12b");
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
  });

  it("strips path-style registry prefixes", () => {
    expect(normalizeModelName("docker.io/ai/gemma3:12b")).toBe("gemma3:12b");
    expect(normalizeModelName("ai/gemma3:12b")).toBe("gemma3:12b");
    expect(normalizeModelName("library/llama3")).toBe("llama3");
  });

  it("trims whitespace before normalizing", () => {
    expect(normalizeModelName("  ai/gemma3:12b  ")).toBe("gemma3:12b");
  });

  it("falls back to the unknown marker for empty/degenerate input", () => {
    expect(normalizeModelName(null)).toBe(UNKNOWN_MODEL);
    expect(normalizeModelName(undefined)).toBe(UNKNOWN_MODEL);
    expect(normalizeModelName("   ")).toBe(UNKNOWN_MODEL);
    expect(normalizeModelName("prefix/")).toBe(UNKNOWN_MODEL);
  });
});
