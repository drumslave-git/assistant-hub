import { describe, expect, it } from "vitest";

import { formatDownloadLine, formatRunReport } from "./format";
import type { BrowserDownloadRecord } from "./types";

const sentFile: BrowserDownloadRecord = {
  sourceUrl: "https://x.com/a",
  filename: "report.pdf",
  sizeBytes: 2 * 1024 * 1024,
  deliveredToChat: true,
};
const keptFile: BrowserDownloadRecord = {
  sourceUrl: "https://x.com/b",
  filename: "movie.mp4",
  sizeBytes: 120 * 1024 * 1024,
  deliveredToChat: false,
};

describe("formatDownloadLine", () => {
  it("shows the filename and size, and never a raw URL", () => {
    const line = formatDownloadLine(sentFile);
    expect(line).toContain("report.pdf");
    expect(line).toContain("2 MB");
    expect(line).not.toContain("https://");
  });

  it("points at the downloads folder only for a file the chat did not get", () => {
    expect(formatDownloadLine(keptFile)).toContain("downloads folder");
    // A delivered file has no server copy left to point at.
    expect(formatDownloadLine(sentFile)).not.toContain("downloads folder");
  });

  it("rounds a sub-megabyte file up to <1 MB", () => {
    expect(formatDownloadLine({ ...sentFile, sizeBytes: 4096 })).toContain("<1 MB");
  });
});

describe("formatRunReport", () => {
  it("returns the report alone when there were no downloads", () => {
    expect(formatRunReport("All done.", [])).toBe("All done.");
  });

  it("appends a files recap after the report", () => {
    const out = formatRunReport("Fetched two files.", [sentFile, keptFile]);
    expect(out.startsWith("Fetched two files.")).toBe(true);
    expect(out).toContain("Files:");
    expect(out).toContain("report.pdf");
    expect(out).toContain("movie.mp4");
  });
});
