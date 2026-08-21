import { describe, expect, it } from "vitest";

import { formatMemoryContext, splitMemoryFacts } from "./format";

describe("splitMemoryFacts", () => {
  it("splits a document into fact lines, dropping bullets and blanks", () => {
    expect(splitMemoryFacts("- Lives in Lisbon.\n\n* Likes rye.\n  \nWorks nights.")).toEqual([
      "Lives in Lisbon.",
      "Likes rye.",
      "Works nights.",
    ]);
  });
});

describe("formatMemoryContext", () => {
  it("marks the sender, so a fact about a bystander is not read as being about them", () => {
    const content = formatMemoryContext([
      { label: "Ada", isSender: true, facts: ["Lives in Lisbon."] },
      { label: "Grace", isSender: false, facts: ["Works nights."] },
    ]);
    expect(content).toContain("Ada (the person you are replying to):");
    expect(content).toContain("- Lives in Lisbon.");
    expect(content).toContain("Grace:");
    expect(content).toContain("- Works nights.");
    expect(content).not.toContain("Grace (the person you are replying to)");
  });

  it("omits people the bot knows nothing about", () => {
    const content = formatMemoryContext([
      { label: "Ada", isSender: true, facts: ["Lives in Lisbon."] },
      { label: "Grace", isSender: false, facts: [] },
    ]);
    expect(content).toContain("Ada");
    expect(content).not.toContain("Grace");
  });

  it("returns null when nothing is known about anyone, so no empty block is injected", () => {
    expect(formatMemoryContext([])).toBeNull();
    expect(formatMemoryContext([{ label: "Ada", isSender: true, facts: [] }])).toBeNull();
  });
});
