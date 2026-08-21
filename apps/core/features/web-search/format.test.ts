import { describe, expect, it } from "vitest";

import {
  extractWebSearchSources,
  formatWebSearchContext,
  formatWebSearchFailure,
  normalizeTavilyResults,
} from "./format";

describe("normalizeTavilyResults", () => {
  it("trims fields, drops fully-empty rows, and falls back a title", () => {
    const results = normalizeTavilyResults([
      { title: "  A  ", url: " https://a ", content: " hi " },
      { title: "", url: "", content: "" },
      { url: "https://b" },
    ]);
    expect(results).toEqual([
      { title: "A", url: "https://a", content: "hi" },
      { title: "https://b", url: "https://b", content: "" },
    ]);
  });

  it("handles undefined rows", () => {
    expect(normalizeTavilyResults(undefined)).toEqual([]);
  });
});

describe("formatWebSearchContext", () => {
  it("includes the summary, numbered sources, and citation guidance", () => {
    const text = formatWebSearchContext("cats", {
      answer: "Cats are great.",
      results: [{ title: "Cat facts", url: "https://cat", content: "Meow." }],
    });
    expect(text).toContain('Web search for "cats"');
    expect(text).toContain("Summary:\nCats are great.");
    expect(text).toContain("1. Cat facts");
    expect(text).toContain("Source: https://cat");
    expect(text).toContain("Cite the relevant source links");
  });

  it("tells the model to use general knowledge when nothing came back", () => {
    const text = formatWebSearchContext("obscure", { answer: null, results: [] });
    expect(text).toContain("returned no results");
    expect(text).toContain("general knowledge");
    expect(text).not.toContain("Sources:");
  });
});

describe("extractWebSearchSources", () => {
  it("de-duplicates by url and defaults a blank title to the url", () => {
    const sources = extractWebSearchSources({
      results: [
        { title: "One", url: "https://x", content: "" },
        { title: "Dup", url: "https://x", content: "" },
        { title: "", url: "https://y", content: "" },
        { title: "No url", url: "", content: "" },
      ],
    });
    expect(sources).toEqual([
      { title: "One", url: "https://x" },
      { title: "https://y", url: "https://y" },
    ]);
  });
});

describe("formatWebSearchFailure", () => {
  it("reports the failure and forbids pretending success", () => {
    const text = formatWebSearchFailure("cats", new Error("boom"));
    expect(text).toContain('failed: boom');
    expect(text).toContain("Do not pretend you searched successfully");
  });
});
