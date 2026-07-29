import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __setDataDirsForTests } from "@/server/paths";

import type { MediaProgress } from "../ytdlp";
import { downloadMediaToDisk, YtDlpMissingError } from "./media-download";

/**
 * The media downloader's plumbing around the yt-dlp binary, proved against a
 * **stub** `yt-dlp` placed on PATH: the argv reaches it, its progress lines are
 * reported, the file it writes is moved into the downloads folder under a safe
 * name, its scratch directory is cleaned up, and its failures are surfaced. No
 * network and no real yt-dlp — the binary's own contract is covered by
 * `../ytdlp.test.ts`, and a real end-to-end download by the live suite.
 *
 * The real downloads directory is fixed at `data/downloads`, so each case
 * redirects it to a throwaway path through the test-only override (as
 * `download.test.ts` does).
 */

/**
 * A stand-in for yt-dlp. Reads its own argv the way the real one does (`-P` is
 * the output directory), then behaves as the case's env vars dictate.
 */
const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
const outDir = args[args.indexOf("-P") + 1];
require("node:fs").writeFileSync(process.env.STUB_ARGV_OUT, JSON.stringify(args));
if (process.env.STUB_FAIL === "1") {
  process.stderr.write("[youtube] abc: Downloading webpage\\nERROR: Video unavailable\\n");
  process.exit(1);
}
process.stdout.write("[youtube] abc: Downloading webpage\\n");
process.stdout.write("YTDLP_PROGRESS 1024 4096 4096 512\\n");
process.stdout.write("YTDLP_PROGRESS 4096 4096 4096 512\\n");
for (const spec of process.env.STUB_FILES.split("|")) {
  const [name, size] = spec.split("=");
  require("node:fs").writeFileSync(outDir + "/" + name, "x".repeat(Number(size)));
}
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

/** A public literal IP: passes the SSRF guard without needing DNS in the test env. */
const PAGE_URL = "https://93.184.216.34/watch?v=abc";
/** The configured download ceiling; the stub never approaches it. */
const TEN_GB = 10 * 1024 ** 3;

let downloadsDir: string;
let binDir: string;
let argvFile: string;
let originalPath: string | undefined;

function loadDownloader(): { downloadMediaToDisk: typeof downloadMediaToDisk; YtDlpMissingError: typeof YtDlpMissingError } {
  __setDataDirsForTests({ downloads: downloadsDir });
  return { downloadMediaToDisk, YtDlpMissingError };
}

beforeEach(() => {
  downloadsDir = mkdtempSync(path.join(tmpdir(), "media-dl-"));
  binDir = mkdtempSync(path.join(tmpdir(), "media-bin-"));
  argvFile = path.join(binDir, "argv.json");

  const stubPath = path.join(binDir, "yt-dlp");
  writeFileSync(stubPath, STUB);
  chmodSync(stubPath, 0o755);

  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.STUB_ARGV_OUT = argvFile;
  process.env.STUB_FILES = "VIRUS (Fytch Remix).mp3=5000";
});

afterEach(() => {
  process.env.PATH = originalPath;
  __setDataDirsForTests(null);
  delete process.env.STUB_ARGV_OUT;
  delete process.env.STUB_FILES;
  delete process.env.STUB_FAIL;
  delete process.env.STUB_EXIT;
  rmSync(downloadsDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

describe("downloadMediaToDisk", () => {
  it("keeps the file yt-dlp produced, named from the media's own title", async () => {
    const { downloadMediaToDisk } = loadDownloader();

    const result = await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB });

    expect(result.filename).toBe("VIRUS (Fytch Remix).mp3");
    expect(result.mime).toBe("audio/mpeg");
    expect(result.sizeBytes).toBe(5000);
    expect(result.filePath).toBe(path.join(path.resolve(downloadsDir), result.filename));
    // The scratch directory is gone; only the finished file remains.
    expect(readdirSync(downloadsDir)).toEqual(["VIRUS (Fytch Remix).mp3"]);
  });

  it("passes the mode through to yt-dlp's format selection", async () => {
    const { downloadMediaToDisk } = loadDownloader();

    await downloadMediaToDisk(PAGE_URL, { mode: "video", maxBytes: TEN_GB });

    const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
    expect(argv[argv.indexOf("-f") + 1]).toBe("bestvideo*+bestaudio/best");
    expect(argv[argv.length - 1]).toBe(PAGE_URL);
  });

  it("reports progress as yt-dlp prints it", async () => {
    const { downloadMediaToDisk } = loadDownloader();
    const seen: MediaProgress[] = [];

    await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB, onProgress: (p) => seen.push(p) });

    expect(seen).toEqual([
      { receivedBytes: 1024, totalBytes: 4096, bytesPerSec: 512 },
      { receivedBytes: 4096, totalBytes: 4096, bytesPerSec: 512 },
    ]);
  });

  it("sanitizes a name that is unsafe on disk", async () => {
    process.env.STUB_FILES = "Live: Set?.mp3=100";
    const { downloadMediaToDisk } = loadDownloader();

    const result = await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB });

    expect(result.filename).toBe("Live Set.mp3");
  });

  it("does not collide with a file already in the downloads folder", async () => {
    writeFileSync(path.join(downloadsDir, "VIRUS (Fytch Remix).mp3"), "old");
    const { downloadMediaToDisk } = loadDownloader();

    const result = await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB });

    expect(result.filename).toBe("VIRUS (Fytch Remix) (1).mp3");
  });

  it("keeps the media, not yt-dlp's leftovers", async () => {
    // A merge can leave a `.part` behind, and it can be bigger than the result.
    process.env.STUB_FILES = "song.mp3=2000|song.f140.m4a.part=9000|song.ytdl=50";
    const { downloadMediaToDisk } = loadDownloader();

    const result = await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB });

    expect(result.filename).toBe("song.mp3");
    expect(result.sizeBytes).toBe(2000);
  });

  it("surfaces yt-dlp's own reason when it produces nothing", async () => {
    process.env.STUB_FAIL = "1";
    const { downloadMediaToDisk } = loadDownloader();

    await expect(downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB })).rejects.toThrow(
      /Video unavailable/,
    );
    // Nothing is left behind by a failed run.
    expect(readdirSync(downloadsDir)).toEqual([]);
  });

  it("keeps a file yt-dlp wrote before exiting non-zero on a post-processing complaint", async () => {
    process.env.STUB_EXIT = "1";
    const { downloadMediaToDisk } = loadDownloader();

    const result = await downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB });

    expect(result.sizeBytes).toBe(5000);
  });

  it("says so plainly when yt-dlp is not installed", async () => {
    process.env.PATH = "/nonexistent";
    const { downloadMediaToDisk, YtDlpMissingError } = loadDownloader();

    await expect(downloadMediaToDisk(PAGE_URL, { mode: "audio", maxBytes: TEN_GB })).rejects.toBeInstanceOf(
      YtDlpMissingError,
    );
  });

  it("blocks a private-network URL before spawning anything", async () => {
    const { downloadMediaToDisk } = loadDownloader();

    await expect(downloadMediaToDisk("http://127.0.0.1/watch", { mode: "audio", maxBytes: TEN_GB })).rejects.toThrow(
      /safety/i,
    );
  });
});
