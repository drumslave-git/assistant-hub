import { describe, expect, it } from "vitest";

import { buildSnapshotScript, formatSnapshot, REF_ATTR, type PageSnapshot } from "./snapshot";

/**
 * The snapshot text is the agent's only view of a page between actions, and it
 * acts by the ref numbers this format assigns. These assertions pin the two
 * things a wrong render would break: the agent seeing what is on the page, and
 * every interactive element carrying a usable ref + destination.
 */

describe("formatSnapshot", () => {
  const base: PageSnapshot = {
    url: "https://example.com/",
    title: "Example",
    text: "Welcome to the page.",
    elements: [
      { ref: 1, role: "link", name: "Pricing", href: "https://example.com/pricing" },
      { ref: 2, role: "text", name: "Search", href: "" },
    ],
  };

  it("shows url, title, text, and every element by ref", () => {
    const out = formatSnapshot(base);
    expect(out).toContain("URL: https://example.com/");
    expect(out).toContain("Title: Example");
    expect(out).toContain("Welcome to the page.");
    expect(out).toContain('[1] link "Pricing" -> https://example.com/pricing');
    // A non-link element shows its ref/role/name but no destination arrow.
    expect(out).toContain('[2] text "Search"');
    expect(out).not.toContain("[2] text \"Search\" ->");
  });

  it("marks a page with no interactive elements explicitly", () => {
    const out = formatSnapshot({ ...base, elements: [] });
    expect(out).toContain("INTERACTIVE ELEMENTS: (none detected)");
  });

  it("names an untitled page rather than leaving it blank", () => {
    const out = formatSnapshot({ ...base, title: "", text: "" });
    expect(out).toContain("Title: (untitled)");
    expect(out).toContain("(no visible text)");
  });
});

describe("buildSnapshotScript", () => {
  it("embeds the ref attribute and element cap as literals (no free variables)", () => {
    const script = buildSnapshotScript(REF_ATTR, 40);
    expect(script).toContain(JSON.stringify(REF_ATTR));
    expect(script).toContain("var limit = 40;");
    // It must be a self-contained IIFE string — page.evaluate receives it verbatim,
    // so a `__name`-style build wrapper (a function reference) would break it.
    expect(script.trim().startsWith("(() => {")).toBe(true);
  });
});
