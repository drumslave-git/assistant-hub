import { describe, expect, it } from "vitest";

import { buildYtDlpArgs, parseYtDlpProgress, summarizeYtDlpError } from "./ytdlp";

/**
 * The contract with the yt-dlp binary lives here so it is verified without the
 * binary installed: the flags that carry a decision, the progress lines it prints,
 * and the failure text the agent reports back.
 */

const TEN_GB = 10 * 1024 ** 3;

const args = (mode: "audio" | "video"): string[] =>
  buildYtDlpArgs({
    url: "https://music.youtube.com/watch?v=abc&list=RD123",
    mode,
    outputDir: "/w",
    maxBytes: TEN_GB,
  });

/** The value that follows a flag, for asserting on pairs in the argv. */
const valueAfter = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];

describe("buildYtDlpArgs", () => {
  it("takes the single track, not the playlist the URL carries", () => {
    // A YouTube Music watch URL usually has a playlist id attached; without this
    // one track becomes the whole radio queue.
    expect(args("audio")).toContain("--no-playlist");
  });

  it("selects best audio and extracts it, for audio mode", () => {
    expect(valueAfter(args("audio"), "-f")).toBe("bestaudio/best");
    expect(args("audio")).toContain("-x");
    // No transcode is forced: re-encoding a lossy source only loses more.
    expect(args("audio")).not.toContain("--audio-format");
  });

  it("selects best video plus best audio and merges, for video mode", () => {
    expect(valueAfter(args("video"), "-f")).toBe("bestvideo*+bestaudio/best");
    expect(valueAfter(args("video"), "--merge-output-format")).toBe("mp4");
  });

  it("caps the file size without capping quality", () => {
    // The configured ceiling, in bytes — yt-dlp refuses before downloading.
    expect(valueAfter(args("video"), "--max-filesize")).toBe(String(TEN_GB));
    // No resolution/bitrate ceiling anywhere in the format selector.
    expect(valueAfter(args("video"), "-f")).not.toMatch(/height|tbr/);
  });

  it("stays hermetic: no user config, no cache directory", () => {
    expect(args("video")).toContain("--ignore-config");
    expect(args("video")).toContain("--no-cache-dir");
  });

  it("writes into the caller's directory under the media's own title", () => {
    expect(valueAfter(args("video"), "-P")).toBe("/w");
    // The title is capped short enough that safeFilename's own 150-char limit
    // cannot later slice the extension off the name.
    expect(valueAfter(args("video"), "-o")).toBe("%(title).120s.%(ext)s");
  });

  it("puts the model-supplied URL last, behind the option terminator", () => {
    const argv = args("video");
    expect(argv[argv.length - 2]).toBe("--");
    expect(argv[argv.length - 1]).toBe("https://music.youtube.com/watch?v=abc&list=RD123");
  });

  it("cannot be turned into an option by a hostile URL", () => {
    const argv = buildYtDlpArgs({
      url: "--exec=rm -rf /",
      mode: "audio",
      outputDir: "/w",
      maxBytes: TEN_GB,
    });
    expect(argv.indexOf("--exec=rm -rf /")).toBeGreaterThan(argv.indexOf("--"));
  });
});

describe("parseYtDlpProgress", () => {
  it("reads a progress line", () => {
    expect(parseYtDlpProgress("YTDLP_PROGRESS 1048576 4194304 4194304 524288.5")).toEqual({
      receivedBytes: 1048576,
      totalBytes: 4194304,
      // Kept as yt-dlp reported it — the formatter rounds for display.
      bytesPerSec: 524288.5,
    });
  });

  it("falls back to the estimate when the exact total is unknown", () => {
    expect(parseYtDlpProgress("YTDLP_PROGRESS 1000 NA 8000 NA")).toEqual({
      receivedBytes: 1000,
      totalBytes: 8000,
      bytesPerSec: 0,
    });
  });

  it("reports an unknown total as 0 rather than guessing", () => {
    expect(parseYtDlpProgress("YTDLP_PROGRESS 1000 NA NA 100")?.totalBytes).toBe(0);
  });

  it("ignores yt-dlp's other output", () => {
    expect(parseYtDlpProgress("[youtube] abc: Downloading webpage")).toBeNull();
    expect(parseYtDlpProgress("")).toBeNull();
  });
});

describe("summarizeYtDlpError", () => {
  it("prefers yt-dlp's own ERROR lines over surrounding noise", () => {
    const stderr = [
      "WARNING: unable to extract something",
      "ERROR: [youtube] abc: Video unavailable",
      "some trailing noise",
    ].join("\n");
    expect(summarizeYtDlpError(stderr)).toBe("ERROR: [youtube] abc: Video unavailable");
  });

  it("falls back to the tail when nothing is marked as an error", () => {
    expect(summarizeYtDlpError("first\nsecond\nthird")).toBe("second | third");
  });

  it("is bounded, so a flood of output cannot blow up the tool result", () => {
    expect(summarizeYtDlpError(`ERROR: ${"x".repeat(5000)}`).length).toBeLessThanOrEqual(400);
  });

  it("is empty for empty output", () => {
    expect(summarizeYtDlpError("")).toBe("");
  });
});
