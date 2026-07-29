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
 * `reachedChat` stands in for what the runner reports back: true when Telegram
 * accepted the document, false for a dashboard run, an over-limit file, or a failed
 * send.
 */
function makeContext(isOwner: boolean, reachedChat = true): AgentToolContext {
  downloads = [];
  delivered = [];
  return {
    session: {
      currentUrl: () => "https://music.youtube.com/watch?v=abc",
      pageMeta: async () => ({ url: "https://music.youtube.com/watch?v=abc", title: "Track - YouTube" }),
    } as unknown as AgentToolContext["session"],
    isOwner,
    downloadMaxMb: 50,
    downloadLimitBytes: 10 * 1024 ** 3,
    downloads,
    onAction: () => {},
    onStep: () => {},
    onScreenshot: async () => 0,
    onDownload: async (record) => {
      delivered.push(record);
      return reachedChat;
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

  it("downloads audio when the agent asks for audio, and delivers the file", async () => {
    const ctx = makeContext(true);

    const result = await call(ctx, { url: "https://music.youtube.com/watch?v=abc", mode: "audio" });

    expect(mockedDownload).toHaveBeenCalledWith(
      "https://music.youtube.com/watch?v=abc",
      expect.objectContaining({ mode: "audio" }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.text).toContain("VIRUS (Fytch Remix).mp3");
    // The file lands in the chat immediately, and on the run row.
    expect(delivered.map((d) => d.filename)).toEqual(["VIRUS (Fytch Remix).mp3"]);
    expect(downloads).toHaveLength(1);
  });

  it("removes the server copy once the chat has the file", async () => {
    const ctx = makeContext(true, true);

    const result = await call(ctx, { url: "https://x.com/watch?v=1", mode: "audio" });

    expect(existsSync(filePath)).toBe(false);
    expect(downloads[0].deliveredToChat).toBe(true);
    // The model must not offer the user a path to a file that is no longer there.
    expect(result.text).toContain("Sent");
    expect(result.text).not.toContain("downloads folder");
  });

  it("keeps the server copy when the file never reached the chat", async () => {
    // A dashboard-started run has no chat, and a failed send looks the same here.
    const ctx = makeContext(true, false);

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
