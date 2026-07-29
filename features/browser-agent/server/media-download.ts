import "server-only";

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { mimeForFilename, safeFilename } from "../files";
import {
  buildYtDlpArgs,
  parseYtDlpProgress,
  summarizeYtDlpError,
  type MediaMode,
  type MediaProgress,
} from "../ytdlp";
import { assertPublicUrl, DOWNLOADS_DIR, uniqueFilename, type DiskDownload } from "./download";

/**
 * Media-page download primitive (`browser_download_media`): hand a **page** URL —
 * a YouTube/YouTube Music/SoundCloud/Vimeo/… watch or track page — to yt-dlp and
 * keep the audio or video it produces.
 *
 * This is the third and last download primitive, and it exists because the other
 * two cannot reach this content at all: `browser_download_file` needs one URL that
 * returns the whole file, `browser_download_stream` needs an HLS/DASH manifest, and
 * a modern media site has neither — its player derives ciphered, per-session,
 * per-format URLs in its own JavaScript. Inspecting the network traffic finds
 * nothing downloadable, which is exactly how the 2026-07-28 YouTube Music run
 * ended with the agent telling the owner to run yt-dlp themselves.
 *
 * Unlike the other two, the URL here is the page the human would open, not a media
 * URL the agent had to dig out — yt-dlp does the digging, per site, and keeps up
 * with the sites changing.
 */

/** Thrown when the run needs yt-dlp but it is not installed. */
export class YtDlpMissingError extends Error {}

export interface MediaDownloadOptions {
  /** Audio-only (a track/song/podcast) or the video. */
  mode: MediaMode;
  /** Hard ceiling in bytes (`settings.browser_download_limit_gb`). */
  maxBytes: number;
  /** Called per yt-dlp progress tick, at its own cadence. */
  onProgress?: (progress: MediaProgress) => void;
}

/** yt-dlp's leftovers — an interrupted transfer or a pre-merge stream. */
const WORK_FILE = /\.(part|ytdl|temp)$/i;

/**
 * Download the audio or video of a media page with yt-dlp and move the result into
 * the downloads folder. Throws {@link YtDlpMissingError} when the binary is absent,
 * and a plain error carrying yt-dlp's own reason (private video, sign-in wall,
 * region block, unsupported site) when the download fails.
 *
 * SSRF: the page URL is checked like every other server-side fetch. yt-dlp then
 * follows the site's own CDN URLs, which is out of our hands — the same accepted
 * limit the stream downloader documents for ffmpeg.
 */
export async function downloadMediaToDisk(
  rawUrl: string,
  options: MediaDownloadOptions,
): Promise<DiskDownload> {
  const url = await assertPublicUrl(rawUrl);
  await fs.mkdir(DOWNLOADS_DIR, { recursive: true });

  // yt-dlp writes into a scratch directory so the pre-merge streams and `.part`
  // files never appear in the folder the operator browses, and so the finished
  // file can be *renamed* into place. The scratch dir lives inside DOWNLOADS_DIR
  // (not the system temp dir) because that rename must not cross a filesystem —
  // under Compose the downloads folder is a bind mount, and a cross-device rename
  // fails.
  const workDir = await fs.mkdtemp(path.join(DOWNLOADS_DIR, ".media-"));

  try {
    const args = buildYtDlpArgs({
      url: url.toString(),
      mode: options.mode,
      outputDir: workDir,
      maxBytes: options.maxBytes,
    });
    const outcome = await runYtDlp(args, options.onProgress);

    if (outcome === "enoent") {
      throw new YtDlpMissingError(
        "Downloading from this site needs yt-dlp, which is not installed on the server.",
      );
    }

    const produced = await pickProducedFile(workDir);
    if (!produced) {
      const reason = summarizeYtDlpError(outcome.stderr) || `exit code ${outcome.code}`;
      throw new Error(`Download failed: ${reason}`);
    }

    const filename = await uniqueFilename(safeFilename(produced.name));
    const filePath = path.join(DOWNLOADS_DIR, filename);
    await fs.rename(path.join(workDir, produced.name), filePath);

    return { filePath, filename, mime: mimeForFilename(filename), sizeBytes: produced.size };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The finished media file in the working directory: the largest file that is not
 * one of yt-dlp's own leftovers. Largest rather than newest because a merged
 * video's leftover audio stream can outlive it by milliseconds, and the media is
 * always the biggest thing there.
 */
async function pickProducedFile(workDir: string): Promise<{ name: string; size: number } | null> {
  const names = await fs.readdir(workDir).catch(() => [] as string[]);
  const candidates: { name: string; size: number }[] = [];
  for (const name of names) {
    if (WORK_FILE.test(name)) continue;
    const stat = await fs.stat(path.join(workDir, name)).catch(() => null);
    if (stat?.isFile() && stat.size > 0) candidates.push({ name, size: stat.size });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.size > a.size ? b : a));
}

/**
 * Split a stream's chunks into whole lines (`--newline` makes yt-dlp emit one
 * status per line, but a chunk can still cut a line in half).
 */
function lineSplitter(onLine: (line: string) => void): (chunk: unknown) => void {
  let tail = "";
  return (chunk) => {
    const lines = (tail + String(chunk)).split(/\r?\n/);
    tail = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  };
}

/**
 * Run yt-dlp to completion, streaming progress as it prints it. Never throws:
 * whether the run produced anything is decided by the caller from the working
 * directory, because yt-dlp can exit non-zero on a post-processing complaint and
 * still have written a perfectly good file.
 *
 * Both streams are scanned for progress and both feed the retained tail, because
 * which one yt-dlp writes its status to has moved between versions — this way
 * progress is never lost, and progress lines never end up quoted as the failure
 * reason.
 */
async function runYtDlp(
  args: string[],
  onProgress?: (progress: MediaProgress) => void,
): Promise<{ code: number; stderr: string } | "enoent"> {
  return new Promise((resolve) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";

    const handle = (line: string): void => {
      const progress = parseYtDlpProgress(line);
      if (progress) {
        onProgress?.(progress);
        return;
      }
      tail = `${tail}${line}\n`.slice(-4000);
    };
    proc.stdout?.on("data", lineSplitter(handle));
    proc.stderr?.on("data", lineSplitter(handle));

    proc.on("error", () => resolve("enoent")); // yt-dlp not installed
    proc.on("close", (code) => resolve({ code: code ?? 1, stderr: tail }));
  });
}
