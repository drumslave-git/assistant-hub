import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpToolCallResult } from "@/server/mcp/tool-result";

import type { BrowserDownloadRecord } from "../types";
import { downloadMediaToDisk, YtDlpMissingError } from "./media-download";
import { BROWSER_AGENT_TOOLS, makeBrowserToolDispatcher, type AgentToolContext } from "./tools";

/**
 * The download tools' dispatch decisions — the parts that are code rather than
 * model judgement: the owner gate, the audio/video default, reporting a missing
 * yt-dlp as an environment fact instead of a generic failure, and the rule that the
 * server copy survives only when the chat did not get the file. yt-dlp itself is
 * mocked; the binary's own contract is covered in `../ytdlp.test.ts`.
 */

vi.mock("./media-download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./media-download")>()),
  downloadMediaToDisk: vi.fn(),
}));

const mockedDownload = vi.mocked(downloadMediaToDisk);

let dir: string;
let filePath: string;
let downloads: BrowserDownloadRecord[];
let delivered: BrowserDownloadRecord[];

/**
 * `outcome` stands in for what the runner reports back: "staged" when the file
 * will ride to the chat with the final report, "kept" for a dashboard run or an
 * over-limit file (the downloads folder keeps the copy), "discarded" for an
 * restricted run's over-limit file (deleted — the audience cannot reach the disk).
 */
function makeContext(
  isOwner: boolean,
  outcome: "staged" | "kept" | "discarded" = "staged",
  allowedDownloadUrls: string[] | null = null,
): AgentToolContext {
  downloads = [];
  delivered = [];
  return {
    session: {
      currentUrl: () => "https://music.youtube.com/watch?v=abc",
      pageMeta: async () => ({ url: "https://music.youtube.com/watch?v=abc", title: "Track - YouTube" }),
    } as unknown as AgentToolContext["session"],
    isOwner,
    allowedDownloadUrls,
    downloadMaxMb: 50,
    downloadLimitBytes: 10 * 1024 ** 3,
    downloads,
    onAction: () => {},
    onStep: () => {},
    onScreenshot: async () => 0,
    onDownload: async (record) => {
      delivered.push(record);
      return outcome;
    },
  };
}

const call = (ctx: AgentToolContext, args: Record<string, unknown>): Promise<McpToolCallResult> =>
  makeBrowserToolDispatcher(ctx)("browser_download_media", args);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "media-tool-"));
  filePath = path.join(dir, "VIRUS (Fytch Remix).mp3");
  writeFileSync(filePath, "audio");
  mockedDownload.mockResolvedValue({
    filePath,
    filename: "VIRUS (Fytch Remix).mp3",
    mime: "audio/mpeg",
    sizeBytes: 5,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("browser_download_media", () => {
  it("is offered to the agent", () => {
    expect(BROWSER_AGENT_TOOLS.map((t) => t.function.name)).toContain("browser_download_media");
  });

  it("downloads audio when the agent asks for audio, and hands the file to the run", async () => {
    const ctx = makeContext(true);

    const result = await call(ctx, { url: "https://music.youtube.com/watch?v=abc", mode: "audio" });

    expect(mockedDownload).toHaveBeenCalledWith(
      "https://music.youtube.com/watch?v=abc",
      expect.objectContaining({ mode: "audio" }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("VIRUS (Fytch Remix).mp3");
    // The file is handed to the runner's stager, and lands on the run row.
    expect(delivered.map((d) => d.filename)).toEqual(["VIRUS (Fytch Remix).mp3"]);
    expect(downloads).toHaveLength(1);
  });

  it("leaves a staged file's server copy to the runner, and says the chat gets it", async () => {
    const ctx = makeContext(true, "staged");

    const result = await call(ctx, { url: "https://x.com/watch?v=1", mode: "audio" });

    // The disk copy survives the handoff — the runner removes it after the
    // combined file+report message is actually delivered.
    expect(existsSync(filePath)).toBe(true);
    expect(downloads[0].deliveredToChat).toBe(false);
    // The model must not offer the user a server path for a file the chat gets.
    expect(result.text).toContain("final report");
    expect(result.text).not.toContain("downloads folder");
  });

  it("keeps the server copy when the file cannot ride to the chat", async () => {
    // A dashboard-started run has no chat; an over-limit file looks the same here.
    const ctx = makeContext(true, "kept");

    const result = await call(ctx, { url: "https://x.com/watch?v=1", mode: "audio" });

    expect(existsSync(filePath)).toBe(true);
    expect(downloads[0].deliveredToChat).toBe(false);
    expect(result.text).toContain("downloads folder");
  });

  it("defaults to video, and treats an unknown mode as video", async () => {
    const ctx = makeContext(true);

    await call(ctx, { url: "https://x.com/watch?v=1" });
    await call(ctx, { url: "https://x.com/watch?v=1", mode: "nonsense" });

    expect(mockedDownload.mock.calls.map((c) => c[1].mode)).toEqual(["video", "video"]);
  });

  it("records the page URL as the source, not the browser's current page", async () => {
    const ctx = makeContext(true);

    // The agent may call this without ever navigating there — yt-dlp opens the
    // page itself, so the URL it was given is the only honest source.
    await call(ctx, { url: "https://soundcloud.com/artist/track", mode: "audio" });

    expect(downloads[0].sourceUrl).toBe("https://soundcloud.com/artist/track");
  });

  it("refuses a non-owner run without touching yt-dlp", async () => {
    const ctx = makeContext(false);

    const result = await call(ctx, { url: "https://x.com/watch?v=1" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/only the owner/i);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
  });

  it("refuses a URL outside a restricted run's scope without touching yt-dlp", async () => {
    const ctx = makeContext(true, "staged", ["https://x.com/i/status/123"]);

    // The Maroon 5 case: the agent picks an unrelated site when the asked-for
    // link fails. The fence refuses it in code, whatever the model decided.
    const result = await call(ctx, { url: "https://www.youtube.com/watch?v=09R8_2nJtjg" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/only download from the link/i);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(delivered).toHaveLength(0);
  });

  it("allows the same site under another of its names (youtu.be → youtube.com)", async () => {
    const ctx = makeContext(true, "staged", ["https://youtu.be/oh9VTJFPzHo?si=x"]);

    // The agent legitimately normalizes a share link to the canonical watch URL.
    const result = await call(ctx, { url: "https://www.youtube.com/watch?v=oh9VTJFPzHo" });

    expect(result.isError).toBeFalsy();
    expect(mockedDownload).toHaveBeenCalled();
  });

  it("deletes a discarded file and tells the agent the delivery failed", async () => {
    const ctx = makeContext(true, "discarded", ["https://music.youtube.com/watch?v=abc"]);

    const result = await call(ctx, { url: "https://music.youtube.com/watch?v=abc", mode: "audio" });

    // Attach or fail: nothing stays on disk, and the record says why.
    expect(existsSync(filePath)).toBe(false);
    expect(downloads[0].discarded).toBe(true);
    expect(downloads[0].deliveredToChat).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/too large to send/i);
    expect(result.text).not.toContain("downloads folder");
  });

  it("reports a missing yt-dlp as an environment fact", async () => {
    mockedDownload.mockRejectedValueOnce(new YtDlpMissingError("yt-dlp is not installed."));
    const ctx = makeContext(true);

    const result = await call(ctx, { url: "https://x.com/watch?v=1" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("yt-dlp is not installed.");
  });

  it("surfaces yt-dlp's own failure reason to the agent", async () => {
    mockedDownload.mockRejectedValueOnce(new Error("yt-dlp failed: ERROR: Video unavailable"));
    const ctx = makeContext(true);

    const result = await call(ctx, { url: "https://x.com/watch?v=1" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Video unavailable");
  });
});
