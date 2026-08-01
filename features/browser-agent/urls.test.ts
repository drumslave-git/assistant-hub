import { describe, expect, it } from "vitest";

import { canonicalHost, extractMessageUrls, isUrlInDownloadScope } from "./urls";

describe("extractMessageUrls", () => {
  it("extracts URLs as pasted, with query strings intact", () => {
    expect(
      extractMessageUrls("https://youtu.be/oh9VTJFPzHo?si=7OBKm0Ft5918u0yd download this)"),
    ).toEqual(["https://youtu.be/oh9VTJFPzHo?si=7OBKm0Ft5918u0yd"]);
  });

  it("keeps a bare link message whole", () => {
    expect(extractMessageUrls("https://x.com/i/status/2083024627761082702")).toEqual([
      "https://x.com/i/status/2083024627761082702",
    ]);
  });

  it("trims sentence punctuation but keeps in-URL punctuation", () => {
    expect(extractMessageUrls("look at https://example.com/a_(b)?q=1, please")).toEqual([
      "https://example.com/a_(b)?q=1",
    ]);
  });

  it("returns several URLs in order, de-duplicated", () => {
    expect(
      extractMessageUrls("https://a.com/1 then https://b.com/2 and again https://a.com/1"),
    ).toEqual(["https://a.com/1", "https://b.com/2"]);
  });

  it("finds nothing in a plain sentence", () => {
    expect(extractMessageUrls("just words, no links")).toEqual([]);
  });
});

describe("canonicalHost", () => {
  it("drops www and folds subdomains to the registrable domain", () => {
    expect(canonicalHost("www.youtube.com")).toBe("youtube.com");
    expect(canonicalHost("music.youtube.com")).toBe("youtube.com");
    expect(canonicalHost("vm.tiktok.com")).toBe("tiktok.com");
  });

  it("canonicalizes known aliases", () => {
    expect(canonicalHost("youtu.be")).toBe("youtube.com");
    expect(canonicalHost("x.com")).toBe("twitter.com");
    expect(canonicalHost("twitter.com")).toBe("twitter.com");
  });
});

describe("isUrlInDownloadScope", () => {
  const allowed = ["https://youtu.be/oh9VTJFPzHo?si=x"];

  it("accepts the exact URL and any same-site URL", () => {
    expect(isUrlInDownloadScope("https://youtu.be/oh9VTJFPzHo?si=x", allowed)).toBe(true);
    // The agent's legitimate rewrite of a share link to the canonical page.
    expect(isUrlInDownloadScope("https://www.youtube.com/watch?v=oh9VTJFPzHo", allowed)).toBe(true);
  });

  it("rejects a different site — the substitute-download case", () => {
    expect(isUrlInDownloadScope("https://soundcloud.com/artist/track", allowed)).toBe(false);
  });

  it("matches x.com and twitter.com either way around", () => {
    expect(
      isUrlInDownloadScope("https://twitter.com/i/status/1", ["https://x.com/i/status/1"]),
    ).toBe(true);
  });

  it("rejects everything when the allowed set is empty or the URL is garbage", () => {
    expect(isUrlInDownloadScope("https://youtube.com/watch?v=1", [])).toBe(false);
    expect(isUrlInDownloadScope("not a url", allowed)).toBe(false);
  });
});
